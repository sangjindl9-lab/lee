'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');
const { clock } = require('./util');

let db;
function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new Database(file);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  d.pragma('busy_timeout = 5000');
  return d;
}

function migrate(d) {
  d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = path.join(__dirname, 'migrations');
  const done = new Set(d.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    d.transaction(() => {
      d.exec(sql);
      d.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
}

const DEFAULT_SETTINGS = {
  pg_fee_bps: '330',                 // 결제 비용 추정치(실제 값은 사업자 정산 자료로 대사)
  pg_fee_bearer: 'platform',         // platform | seller
  fee_vat_included: '1',             // 플랫폼 수수료에 부가세 포함 여부(세무 검토 필요)
  settlement_cycle: 'on_confirm',    // on_confirm | weekly
  dispute_buffer_days: '3',          // 검수 종료 후 분쟁 접수·보류 요청에 필요한 여유일
  auto_confirm_enabled: '0',         // 검수 기한 경과 시 자동확정(사업자·운영 정책 확인 후에만 켠다)
  appeal_days: '7',
  bank_change_hold_hours: '72',
  high_value_threshold: '5000000',   // 이 금액 이상이면 별도 확인 절차 선택 가능
  retention_days: '1825',            // 판매자 삭제·탈퇴 후에도 기존 주문 납품물을 보관하는 기간
  download_link_minutes: '10',
  require_malware_scan: '0',         // 1이면 악성 파일 검사 '검사 불가' 파일은 판매 승인 불가
  live_mode: '0',
  withholding_enabled: '1',          // 개인(비사업자) 판매자 지급 시 사업소득 원천징수 공제
  withholding_income_bps: '300',     // 소득세 3%
  withholding_local_pct: '10',       // 지방소득세 = 소득세의 10%
  withholding_min_tax: '0',          // 소액부징수 기준(원). 0이면 적용 안 함 — 세무 검토 후 설정
};
const DEFAULT_CATEGORIES = [
  ['erp', 'ERP·그룹웨어'], ['construction', '건설·전기·통신'], ['accounting', '회계·견적·발주·재고'],
  ['automation', '문서·PDF·엑셀 자동화'], ['commerce', '쇼핑몰·예약·고객관리'], ['ai', 'AI 도구'],
  ['mobile', '모바일 앱'], ['education', '교육·콘텐츠'], ['devtools', '개발 도구·플러그인'],
];

function seedDefaults(d) {
  const now = new Date().toISOString();
  const insS = d.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insS.run(k, v, now);
  const insC = d.prepare('INSERT OR IGNORE INTO categories (slug, name, sort) VALUES (?, ?, ?)');
  DEFAULT_CATEGORIES.forEach(([s, n], i) => insC.run(s, n, i));
  if (!d.prepare("SELECT 1 FROM fee_policies WHERE scope='default'").get()) {
    d.prepare("INSERT INTO fee_policies (scope, rate_bps, label, created_at) VALUES ('default', 1000, '기본 수수료', ?)").run(now);
  }
}

function init(file) {
  db = open(file || path.join(config.dataDir, 'eum.db'));
  migrate(db);
  seedDefaults(db);
  return db;
}
const get = () => db || init(config.isTest ? ':memory:' : undefined);

// 짧은 헬퍼
const q = {
  get: (sql, ...p) => get().prepare(sql).get(...p),
  all: (sql, ...p) => get().prepare(sql).all(...p),
  run: (sql, ...p) => get().prepare(sql).run(...p),
  tx: (fn) => get().transaction(fn)(),
  // IMMEDIATE 트랜잭션: 읽고-확인하고-쓰는 구간을 직렬화한다.
  txi: (fn) => get().transaction(fn).immediate(),
  setting: (k) => get().prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value,
  settingInt: (k) => parseInt(get().prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '0', 10),
  insert(table, row) {
    const keys = Object.keys(row);
    return get().prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k])).lastInsertRowid;
  },
  update(table, id, row, idCol = 'id') {
    const keys = Object.keys(row);
    return get().prepare(`UPDATE ${table} SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE ${idCol} = ?`).run(...keys.map((k) => row[k]), id);
  },
};

function resetForTest() { if (db) db.close(); db = null; clock.reset(); return init(':memory:'); }

module.exports = { init, get, q, resetForTest, DEFAULT_SETTINGS };
if (require.main === module) { init(); console.log('마이그레이션 완료'); }
