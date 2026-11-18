'use strict';
// 비공개 파일 저장소. 파일마다 임의의 데이터 키로 AES-256-GCM 암호화하고,
// 데이터 키는 마스터 키(FILE_MASTER_KEY)로 감싸서 DB에 둔다. 웹 루트 밖에 저장한다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const config = require('./config');
const { q } = require('./db');
const { clock, AppError, randomId } = require('./util');
const scanner = require('./scanner');

const master = Buffer.from(config.fileMasterKey, 'hex');
const filesDir = () => path.join(config.dataDir, 'files');
const tmpDir = () => { const d = path.join(config.dataDir, 'tmp'); fs.mkdirSync(d, { recursive: true }); return d; };
const pathOf = (key) => path.join(filesDir(), key.slice(0, 2), key + '.enc');

function wrap(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', master, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function unwrap(b64) {
  const raw = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', master, raw.slice(0, 12));
  d.setAuthTag(raw.slice(12, 28));
  return Buffer.concat([d.update(raw.slice(28)), d.final()]);
}
const encryptText = (s) => wrap(Buffer.from(String(s), 'utf8'));
const decryptText = (b64) => unwrap(b64).toString('utf8');

// 임시 경로의 평문 파일을 검사·암호화해 보관한다. 평문 임시 파일은 항상 지운다.
async function saveFromPath(tmpPath, { originalName, uploaderId, purpose }) {
  try {
    const size = fs.statSync(tmpPath).size;
    if (size === 0) throw new AppError('빈 파일(0바이트)은 등록할 수 없습니다.', 400, 'EMPTY_FILE');
    if (size > config.maxUploadBytes) throw new AppError('업로드 용량 제한을 넘었습니다.', 413, 'TOO_LARGE');
    const name = path.basename(String(originalName || 'file')).replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'file';
    const scan = await scanner.scanFile(tmpPath, name);
    const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
    const storageKey = randomId(20);
    const dest = pathOf(storageKey);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const hash = crypto.createHash('sha256');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const src = fs.createReadStream(tmpPath);
    src.on('data', (c) => hash.update(c));
    await pipeline(src, cipher, fs.createWriteStream(dest, { mode: 0o600 }));
    const id = q.insert('files', {
      storage_key: storageKey, original_name: name, size, sha256: hash.digest('hex'),
      key_id: config.fileMasterKeyId, wrapped_key: wrap(key), iv: iv.toString('base64'), auth_tag: cipher.getAuthTag().toString('base64'),
      uploader_id: uploaderId, purpose,
      scan_malware: scan.malware, scan_secrets: scan.secrets, scan_archive: scan.archive,
      scan_report: JSON.stringify(scan.report), scanned_at: clock.iso(), created_at: clock.iso(),
    });
    return q.get('SELECT * FROM files WHERE id = ?', id);
  } finally {
    fs.rm(tmpPath, { force: true }, () => {});
  }
}
async function saveBuffer(buf, meta) {
  const p = path.join(tmpDir(), 'buf-' + randomId(8));
  fs.writeFileSync(p, buf, { mode: 0o600 });
  return saveFromPath(p, meta);
}

// 저장소에서 실제로 읽을 수 있는지 확인(접근 권한 발급 전 확인용)
function isReadable(file) {
  try { const st = fs.statSync(pathOf(file.storage_key)); return st.size === file.size; } catch { return false; }
}
function openStream(file) {
  const d = crypto.createDecipheriv('aes-256-gcm', unwrap(file.wrapped_key), Buffer.from(file.iv, 'base64'));
  d.setAuthTag(Buffer.from(file.auth_tag, 'base64'));
  return fs.createReadStream(pathOf(file.storage_key)).pipe(d);
}
async function readAll(file) {
  const chunks = []; for await (const c of openStream(file)) chunks.push(c); return Buffer.concat(chunks);
}
module.exports = { saveFromPath, saveBuffer, isReadable, openStream, readAll, pathOf, tmpDir, encryptText, decryptText };
