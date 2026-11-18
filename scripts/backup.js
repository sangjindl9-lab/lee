'use strict';
// 백업: SQLite 일관 사본(VACUUM INTO, 서비스 중 실행 가능) + 암호화 파일 저장소 복사.
// 사용: node scripts/backup.js /백업/경로
// 복구: 서버를 멈추고 백업의 eum.db와 files/를 DATA_DIR에 되돌린 뒤 같은 FILE_MASTER_KEY로 기동.
// FILE_MASTER_KEY는 이 백업에 들어 있지 않다. 키를 잃으면 납품 파일을 복호화할 수 없으므로 별도 보관한다.
const fs = require('fs');
const path = require('path');
const Database = require('../src/sqlite');
const config = require('../src/config');

(async () => {
  const dest = process.argv[2];
  if (!dest) { console.error('백업 경로를 지정하세요.'); process.exit(1); }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(dest, 'eum-' + stamp);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(config.dataDir, 'eum.db'), { readonly: true });
  // VACUUM INTO: 서비스 중에도 일관된 사본을 만든다.
  db.exec(`VACUUM INTO '${path.join(dir, 'eum.db').replace(/'/g, "''")}'`);
  db.close();
  const check = new Database(path.join(dir, 'eum.db'), { readonly: true });
  const ok = check.pragma('integrity_check', { simple: true });
  const files = check.prepare('SELECT COUNT(*) c FROM files').get().c;
  check.close();
  const src = path.join(config.dataDir, 'files');
  if (fs.existsSync(src)) fs.cpSync(src, path.join(dir, 'files'), { recursive: true });
  const copied = fs.existsSync(path.join(dir, 'files')) ? fs.readdirSync(path.join(dir, 'files'), { recursive: true }).filter((f) => f.endsWith('.enc')).length : 0;
  console.log(`백업 완료: ${dir} (DB 무결성 ${ok}, 파일 레코드 ${files}건, 복사된 암호화 파일 ${copied}개)`);
  if (ok !== 'ok' || copied < files) process.exit(2);
})();
