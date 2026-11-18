'use strict';
const crypto = require('crypto');

// 테스트에서 시간을 옮길 수 있도록 시계를 한곳에 둔다.
let offsetMs = 0;
const clock = {
  now: () => new Date(Date.now() + offsetMs),
  iso: () => clock.now().toISOString(),
  advanceDays: (d) => { offsetMs += d * 86400000; },
  advanceMinutes: (m) => { offsetMs += m * 60000; },
  reset: () => { offsetMs = 0; },
};
const addDays = (iso, days) => new Date(new Date(iso).getTime() + days * 86400000).toISOString();
const addMinutes = (iso, m) => new Date(new Date(iso).getTime() + m * 60000).toISOString();

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

// 키 순서를 고정한 JSON(조건 해시용)
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

// 원화: 정수만 허용
function toWon(input) {
  const s = String(input ?? '').replace(/[,\s원]/g, '');
  if (!/^\d{1,12}$/.test(s)) throw new AppError('금액은 원 단위 정수로 입력하세요.');
  return Number(s);
}
const won = (n) => (n == null ? '-' : Number(n).toLocaleString('ko-KR') + '원');
const bpsOf = (amount, bps) => Math.floor((amount * bps) / 10000);
const bpsPct = (bps) => (bps / 100).toFixed(bps % 100 ? 2 : 0) + '%';

function fmtDate(iso, withTime = true) {
  if (!iso) return '-';
  const d = new Date(new Date(iso).getTime() + 9 * 3600000); // KST
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`;
  return withTime ? `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : date;
}

class AppError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; this.expose = true; }
}
const forbidden = (msg = '접근 권한이 없습니다.') => new AppError(msg, 403, 'FORBIDDEN');
const notFound = (msg = '찾을 수 없습니다.') => new AppError(msg, 404, 'NOT_FOUND');
const must = (cond, msg, status = 400, code = 'BAD_REQUEST') => { if (!cond) throw new AppError(msg, status, code); };
const str = (v, max = 5000) => String(v ?? '').trim().slice(0, max);
const int = (v, def = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; };

module.exports = { clock, addDays, addMinutes, sha256, randomId, stableStringify, toWon, won, bpsOf, bpsPct, fmtDate, AppError, forbidden, notFound, must, str, int };
