'use strict';
// 업로드 파일 검사. 세 항목은 서로 독립이며 결과도 따로 저장한다.
//  - archive : 압축 구조(압축 폭탄, 경로 탈출)
//  - secrets : 비밀키·운영 환경변수·개인정보로 보이는 내용
//  - malware : ClamAV(설정된 경우). 없으면 "검사 불가"로 남긴다. 통과로 표시하지 않는다.
// 업로드된 코드를 실행하지 않는다.
const fs = require('fs');
const zlib = require('zlib');
const { execFile } = require('child_process');
const config = require('./config');

const LIMITS = { entries: 20000, totalBytes: 2 * 1024 ** 3, ratio: 200, textEntryBytes: 2 * 1024 ** 2, scanBudget: 64 * 1024 ** 2 };
const TEXT_EXT = /\.(txt|md|json|ya?ml|env|ini|conf|cfg|toml|xml|properties|js|ts|jsx|tsx|py|java|kt|go|rb|php|cs|c|cpp|h|sh|bat|ps1|sql|csv|html?|css|gradle|pem|key|tf)$/i;
const ENV_NAME = /(^|\/)\.env(\.[\w-]+)?$/i;
const ENV_SAMPLE = /(example|sample|template|dist)/i;
const NESTED = /\.(zip|7z|rar|tar|tgz|gz|jar|war)$/i;
const PLACEHOLDER = /(change[_-]?me|your[_-]|xxxx|example|sample|placeholder|<[^>]+>|\*{4,}|\$\{|process\.env|os\.environ|dummy|test[_-]?key)/i;
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

const RULES = [
  ['private_key', '개인키(PEM)', /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY/],
  ['aws_key', 'AWS 액세스 키', /\bAKIA[0-9A-Z]{16}\b/],
  ['live_api_key', '운영용 API 키로 보이는 값', /\b(sk_live_|live_sk_|rk_live_|sk-ant-|ghp_|github_pat_|xox[baprs]-|AIza[0-9A-Za-z_-]{30,})[0-9A-Za-z_-]{8,}/],
  ['rrn', '주민등록번호 형식', /\b\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])-[1-4]\d{6}\b/],
];
const ASSIGN = /(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i;

function scanText(name, text, findings) {
  const lines = text.split('\n');
  let phones = 0, emails = 0;
  const isEnv = ENV_NAME.test(name) && !ENV_SAMPLE.test(name);
  let envValues = 0;
  for (let i = 0; i < lines.length && findings.length < 50; i++) {
    const line = lines[i];
    if (line.length > 5000) continue;
    for (const [rule, label, re] of RULES) if (re.test(line)) findings.push({ rule, label, entry: name, line: i + 1 });
    const m = line.match(ASSIGN);
    if (m && !PLACEHOLDER.test(m[2]) && !PLACEHOLDER.test(line)) findings.push({ rule: 'hardcoded_secret', label: '코드에 직접 적힌 비밀값으로 보임', entry: name, line: i + 1 });
    if (isEnv && /^[A-Z0-9_]+=\S{6,}/.test(line) && !PLACEHOLDER.test(line)) envValues++;
    phones += (line.match(/\b01[016789]-?\d{3,4}-?\d{4}\b/g) || []).length;
    emails += (line.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []).length;
  }
  if (isEnv && envValues >= 1) findings.push({ rule: 'env_file', label: '실제 값이 든 환경변수 파일로 보임(.env.example만 포함하세요)', entry: name, line: 0 });
  if (phones >= 20 || emails >= 50) findings.push({ rule: 'pii_bulk', label: `다수의 연락처가 담긴 데이터로 보임(전화 ${phones}건, 이메일 ${emails}건)`, entry: name, line: 0 });
}

function badPath(name) {
  return name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes('..');
}

// ── ZIP: 중앙 디렉터리를 직접 읽어 압축을 풀지 않고 구조를 확인한다.
function inspectZip(fd, size, out) {
  const tailLen = Math.min(size, 65557);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) { out.archive = 'unscannable'; out.notes.push('ZIP 구조를 읽을 수 없습니다.'); return; }
  const total = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOff === 0xffffffff) { out.archive = 'unscannable'; out.notes.push('ZIP64 형식은 구조 검사를 지원하지 않습니다.'); return; }
  if (cdSize > 64 * 1024 ** 2 || cdOff + cdSize > size) { out.archive = 'flagged'; out.problems.push('중앙 디렉터리가 비정상입니다.'); return; }
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOff);
  let p = 0, sum = 0, n = 0, budget = LIMITS.scanBudget;
  const entries = [];
  while (p + 46 <= cdSize && cd.readUInt32LE(p) === 0x02014b50) {
    const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), comp = cd.readUInt32LE(p + 20), uncomp = cd.readUInt32LE(p + 24);
    const nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32), lho = cd.readUInt32LE(p + 42);
    const name = cd.slice(p + 46, p + 46 + nl).toString('utf8');
    entries.push({ name, method, comp, uncomp, lho, encrypted: !!(flags & 1) });
    sum += uncomp; n++;
    p += 46 + nl + el + cl;
    if (n > LIMITS.entries) break;
  }
  out.entryCount = n; out.uncompressedBytes = sum;
  if (n > LIMITS.entries) out.problems.push(`항목 수가 너무 많습니다(${LIMITS.entries}개 초과).`);
  if (sum > LIMITS.totalBytes) out.problems.push('압축 해제 시 용량이 제한(2GB)을 넘습니다.');
  if (size > 0 && sum / size > LIMITS.ratio) out.problems.push(`압축률이 비정상적으로 높습니다(${Math.round(sum / size)}배).`);
  const bad = entries.filter((e) => badPath(e.name)).slice(0, 5);
  if (bad.length) out.problems.push('압축 경로 탈출 시도: ' + bad.map((e) => e.name).join(', '));
  if (entries.some((e) => e.encrypted)) { out.notes.push('암호가 걸린 항목은 내용을 검사하지 못했습니다.'); out.secretsPartial = true; }
  if (entries.some((e) => NESTED.test(e.name))) { out.notes.push('압축 파일 안의 압축 파일은 내부를 검사하지 않았습니다.'); out.secretsPartial = true; }
  out.archive = out.problems.length ? 'flagged' : 'passed';
  out.entryNames = entries.slice(0, 500).map((e) => e.name);
  if (out.archive === 'flagged') return;
  // 내용 검사(텍스트로 보이는 작은 항목만)
  for (const e of entries) {
    if (e.encrypted || e.uncomp === 0 || e.uncomp > LIMITS.textEntryBytes || budget < e.uncomp) continue;
    if (!TEXT_EXT.test(e.name) && !ENV_NAME.test(e.name)) continue;
    try {
      const lh = Buffer.alloc(30);
      fs.readSync(fd, lh, 0, 30, e.lho);
      if (lh.readUInt32LE(0) !== 0x04034b50) continue;
      const start = e.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const raw = Buffer.alloc(e.comp);
      fs.readSync(fd, raw, 0, e.comp, start);
      const data = e.method === 0 ? raw : e.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: LIMITS.textEntryBytes }) : null;
      if (!data) continue;
      budget -= data.length;
      const text = data.toString('utf8');
      if (text.includes(EICAR)) out.eicar = true;
      scanText(e.name, text, out.findings);
    } catch { out.notes.push(`${e.name}: 내용을 읽지 못했습니다.`); }
  }
}

// ── TAR / TAR.GZ: 스트림으로 헤더만 따라가며 확인한다.
function inspectTar(file, gz, size, out) {
  return new Promise((resolve) => {
    let src = fs.createReadStream(file);
    if (gz) src = src.pipe(zlib.createGunzip());
    let buf = Buffer.alloc(0), total = 0, n = 0, skip = 0, cur = null, done = false;
    const finish = (status, msg) => {
      if (done) return; done = true;
      if (msg) (status === 'flagged' ? out.problems : out.notes).push(msg);
      out.archive = out.problems.length ? 'flagged' : status;
      out.entryCount = n; out.uncompressedBytes = total;
      src.destroy(); resolve();
    };
    src.on('data', (chunk) => {
      total += chunk.length;
      if (total > LIMITS.totalBytes) return finish('flagged', '압축 해제 시 용량이 제한(2GB)을 넘습니다.');
      if (size > 0 && total / size > LIMITS.ratio && total > 50 * 1024 ** 2) return finish('flagged', '압축률이 비정상적으로 높습니다.');
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (cur) {
          if (buf.length < cur.padded) break;
          if (cur.keep) { const text = buf.slice(0, cur.size).toString('utf8'); if (text.includes(EICAR)) out.eicar = true; scanText(cur.name, text, out.findings); }
          buf = buf.slice(cur.padded); cur = null; continue;
        }
        if (skip > 0) { const k = Math.min(skip, buf.length); buf = buf.slice(k); skip -= k; if (skip > 0) break; continue; }
        if (buf.length < 512) break;
        const h = buf.slice(0, 512); buf = buf.slice(512);
        if (h.every((b) => b === 0)) continue;
        const nm = h.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
        const prefix = h.slice(345, 500).toString('utf8').replace(/\0.*$/, '');
        const name = prefix ? prefix + '/' + nm : nm;
        const sz = parseInt(h.slice(124, 136).toString('ascii').replace(/[^0-7]/g, '') || '0', 8);
        const type = String.fromCharCode(h[156] || 48);
        n++;
        if (n > LIMITS.entries) return finish('flagged', `항목 수가 너무 많습니다(${LIMITS.entries}개 초과).`);
        if (badPath(name)) out.problems.push('압축 경로 탈출 시도: ' + name);
        if (type === '2' || type === '1') { const link = h.slice(157, 257).toString('utf8').replace(/\0.*$/, ''); if (badPath(link)) out.problems.push('외부를 가리키는 링크: ' + name); }
        if (out.entryNames.length < 500) out.entryNames.push(name);
        if (NESTED.test(name)) out.secretsPartial = true;
        const padded = Math.ceil(sz / 512) * 512;
        const keep = (type === '0' || type === '\0') && sz > 0 && sz <= LIMITS.textEntryBytes && (TEXT_EXT.test(name) || ENV_NAME.test(name));
        if (keep) cur = { name, size: sz, padded, keep }; else skip = padded;
      }
    });
    src.on('end', () => finish('passed'));
    src.on('error', () => finish('unscannable', '압축 파일을 끝까지 읽지 못했습니다.'));
  });
}

function clam(file) {
  return new Promise((resolve) => {
    if (!config.clamscanPath) return resolve({ status: 'unscannable', note: '악성 파일 검사 엔진이 연결되어 있지 않습니다.' });
    execFile(config.clamscanPath, ['--no-summary', file], { timeout: 120000 }, (err, stdout) => {
      if (!err) return resolve({ status: 'passed', note: 'ClamAV 검사에서 탐지된 항목 없음' });
      if (err.code === 1) return resolve({ status: 'flagged', note: 'ClamAV 탐지: ' + String(stdout).trim().slice(0, 200) });
      resolve({ status: 'unscannable', note: '악성 파일 검사 실행 실패' });
    });
  });
}

async function scanFile(file, name) {
  const size = fs.statSync(file).size;
  const out = { archive: 'passed', secrets: 'passed', malware: 'unscannable', findings: [], problems: [], notes: [], entryNames: [], secretsPartial: false, eicar: false };
  const lower = name.toLowerCase();
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(size, 8));
    fs.readSync(fd, head, 0, head.length, 0);
    const isZip = head.length >= 4 && head.readUInt32LE(0) === 0x04034b50;
    const isGz = head[0] === 0x1f && head[1] === 0x8b;
    if (isZip) inspectZip(fd, size, out);
    else if (isGz && /\.(tgz|tar\.gz)$/.test(lower)) await inspectTar(file, true, size, out);
    else if (/\.tar$/.test(lower)) await inspectTar(file, false, size, out);
    else if (isGz || /\.(7z|rar|xz|bz2|zst)$/.test(lower)) {
      out.archive = 'unscannable'; out.secrets = 'unscannable';
      out.notes.push('이 압축 형식은 구조·내용 검사를 지원하지 않습니다. ZIP 또는 TAR.GZ로 올리면 검사할 수 있습니다.');
    } else {
      out.notes.push('압축 파일이 아니므로 압축 구조 검사는 해당 없음');
      if (size <= LIMITS.textEntryBytes * 4) {
        const data = fs.readFileSync(file);
        const text = data.toString('utf8');
        if (text.includes(EICAR)) out.eicar = true;
        if (TEXT_EXT.test(lower) || ENV_NAME.test(lower) || !data.slice(0, 4096).includes(0)) scanText(name, text, out.findings);
        else { out.secrets = 'unscannable'; out.notes.push('실행 파일·바이너리는 내용 기반 비밀값 검사를 하지 않습니다.'); }
      } else { out.secrets = 'unscannable'; out.notes.push('큰 단일 파일은 내용 검사를 하지 않습니다.'); }
    }
  } catch (e) {
    out.archive = 'unscannable'; out.notes.push('검사 중 오류: ' + e.message);
  } finally { fs.closeSync(fd); }
  if (out.secrets !== 'unscannable') {
    if (out.archive === 'flagged' || out.archive === 'unscannable') out.secrets = 'unscannable';
    else if (out.findings.length) out.secrets = 'flagged';
    else if (out.secretsPartial) { out.secrets = 'passed'; out.notes.push('비밀값 검사는 읽을 수 있었던 텍스트 항목에 한해 수행했습니다.'); }
  }
  const c = await clam(file);
  out.malware = out.eicar ? 'flagged' : c.status;
  out.notes.push(out.eicar ? '악성 파일 시험 서명(EICAR)이 발견되었습니다.' : c.note);
  return {
    malware: out.malware, secrets: out.secrets, archive: out.archive,
    report: { findings: out.findings, problems: out.problems, notes: out.notes, entryCount: out.entryCount, uncompressedBytes: out.uncompressedBytes, entryNames: out.entryNames },
  };
}

// 종합 표시용. 통과는 "모든 항목이 실제로 검사되어 통과"일 때만.
function overall(f) {
  const s = [f.scan_malware, f.scan_secrets, f.scan_archive];
  if (s.includes('flagged')) return 'flagged';
  if (s.includes('pending')) return 'pending';
  if (s.includes('scanning')) return 'scanning';
  if (s.includes('unscannable')) return 'unscannable';
  return 'passed';
}
module.exports = { scanFile, overall, EICAR };
