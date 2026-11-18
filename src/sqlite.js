'use strict';
// Node.js 내장 SQLite(node:sqlite)를 얇게 감싼다. 네이티브 모듈을 컴파일할 필요가 없어
// Windows에서도 빌드 도구 없이 설치된다. Node.js 22.13 이상이 필요하다.
const { DatabaseSync } = require('node:sqlite');

class Database {
  constructor(file, opts = {}) {
    this.db = new DatabaseSync(file, { readOnly: !!opts.readonly });
    this.depth = 0;
  }
  prepare(sql) { return this.db.prepare(sql); }
  exec(sql) { this.db.exec(sql); return this; }
  pragma(text, { simple = false } = {}) {
    const rows = this.db.prepare('PRAGMA ' + text).all();
    return simple ? (rows[0] ? Object.values(rows[0])[0] : undefined) : rows;
  }
  close() { this.db.close(); }
  // 트랜잭션. 바깥은 BEGIN(또는 BEGIN IMMEDIATE), 안쪽에서 다시 열면 SAVEPOINT로 중첩한다.
  transaction(fn) {
    const run = (begin) => (...args) => {
      const outer = this.depth === 0;
      const sp = `sp_${this.depth}`;
      this.db.exec(outer ? begin : `SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const out = fn(...args);
        this.depth--;
        this.db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
        return out;
      } catch (e) {
        this.depth--;
        try { this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`); } catch { /* 이미 되돌려진 경우 */ }
        throw e;
      }
    };
    const t = run('BEGIN');
    t.immediate = run('BEGIN IMMEDIATE');
    return t;
  }
}
module.exports = Database;
