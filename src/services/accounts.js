'use strict';
const crypto = require('crypto');
const { q } = require('../db');
const { clock, addDays, sha256, must, str, AppError } = require('../util');
const storage = require('../storage');
const { audit, notify } = require('../log');

const hashPw = (pw) => { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`; };
function checkPw(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}

function register({ email, password, name, phone }) {
  email = str(email, 200).toLowerCase();
  must(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), '이메일 형식이 올바르지 않습니다.');
  must(String(password || '').length >= 10, '비밀번호는 10자 이상이어야 합니다.');
  must(str(name, 50).length >= 2, '이름을 입력하세요.');
  must(!q.get('SELECT 1 FROM users WHERE email = ?', email), '이미 가입된 이메일입니다.', 409);
  const id = q.insert('users', { email, password_hash: hashPw(password), name: str(name, 50), phone: str(phone, 30), created_at: clock.iso() });
  return q.get('SELECT * FROM users WHERE id = ?', id);
}

// 로그인 시도 제한(메모리). 여러 인스턴스로 운영할 때는 공유 저장소로 옮겨야 한다.
const attempts = new Map();
function login(email, password, ip) {
  const key = `${str(email, 200).toLowerCase()}|${ip}`;
  const a = attempts.get(key) || { n: 0, until: 0 };
  if (a.until > Date.now()) throw new AppError('로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.', 429);
  const u = q.get('SELECT * FROM users WHERE email = ?', str(email, 200));
  if (!u || u.status !== 'active' || !checkPw(password, u.password_hash)) {
    a.n++; if (a.n >= 5) { a.until = Date.now() + 10 * 60000; a.n = 0; }
    attempts.set(key, a);
    throw new AppError('이메일 또는 비밀번호가 올바르지 않습니다.', 401);
  }
  attempts.delete(key);
  return u;
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.insert('sessions', { token_hash: sha256(token), user_id: userId, csrf: crypto.randomBytes(16).toString('hex'), reauth_at: clock.iso(), created_at: clock.iso(), expires_at: addDays(clock.iso(), 14) });
  return token;
}
function sessionUser(token) {
  if (!token) return null;
  const s = q.get('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', sha256(token), clock.iso());
  if (!s) return null;
  const u = q.get("SELECT id, email, name, phone, status, totp_enabled FROM users WHERE id = ? AND status = 'active'", s.user_id);
  if (!u) return null;
  u.staff = q.all('SELECT role FROM staff_roles WHERE user_id = ?', u.id).map((r) => r.role);
  u.auditRole = u.staff.length ? 'staff:' + u.staff.join(',') : 'user';
  u.seller = q.get('SELECT * FROM seller_profiles WHERE user_id = ?', u.id) || null;
  u.session = { hash: s.token_hash, csrf: s.csrf, mfaOk: !!s.mfa_ok, reauthAt: s.reauth_at };
  return u;
}
const destroySession = (token) => q.run('DELETE FROM sessions WHERE token_hash = ?', sha256(String(token)));

// 민감 작업 전 비밀번호 재확인(10분 유효)
function reauth(user, password) {
  const u = q.get('SELECT * FROM users WHERE id = ?', user.id);
  must(checkPw(password, u.password_hash), '비밀번호가 올바르지 않습니다.', 401);
  q.run('UPDATE sessions SET reauth_at = ? WHERE token_hash = ?', clock.iso(), user.session.hash);
}
const recentlyReauthed = (user) => user.session.reauthAt && clock.now() - new Date(user.session.reauthAt) < 10 * 60000;

// ── TOTP(RFC 6238) — 운영자 추가 인증
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32encode = (buf) => { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
const b32decode = (s) => { let bits = ''; for (const c of s.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
function totp(secret, t = Date.now()) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
const totpOk = (secret, code) => [-1, 0, 1].some((d) => totp(secret, Date.now() + d * 30000) === String(code || '').trim());
function totpBegin(user) {
  const secret = b32encode(crypto.randomBytes(20));
  q.update('users', user.id, { totp_secret: storage.encryptText(secret), totp_enabled: 0 });
  return { secret, uri: `otpauth://totp/EUM%20MARKET:${encodeURIComponent(user.email)}?secret=${secret}&issuer=EUM%20MARKET` };
}
function totpVerify(user, code) {
  const u = q.get('SELECT * FROM users WHERE id = ?', user.id);
  must(u.totp_secret && totpOk(storage.decryptText(u.totp_secret), code), '인증 코드가 올바르지 않습니다.', 401);
  q.update('users', u.id, { totp_enabled: 1 });
  q.run('UPDATE sessions SET mfa_ok = 1 WHERE token_hash = ?', user.session.hash);
  audit(user, 'mfa.verify', 'user', u.id);
}

// ── 판매자
function applySeller(user, { displayName, intro, skills, portfolio, bizType, bizNo }) {
  must(str(displayName, 60).length >= 2, '상점 이름을 입력하세요.');
  const row = { display_name: str(displayName, 60), intro: str(intro, 2000), skills: str(skills, 500), portfolio: str(portfolio, 3000), biz_type: ['individual', 'sole', 'corp'].includes(bizType) ? bizType : 'individual', biz_no: str(bizNo, 20) };
  const ex = q.get('SELECT * FROM seller_profiles WHERE user_id = ?', user.id);
  if (ex) q.update('seller_profiles', user.id, { ...row, status: ex.status === 'rejected' ? 'pending' : ex.status }, 'user_id');
  else q.insert('seller_profiles', { user_id: user.id, ...row, created_at: clock.iso() });
  require('../log').notifyStaff('review', '판매자 심사 요청', row.display_name, '/admin/sellers');
}
function reviewSeller(admin, userId, { status, note }) {
  must(['approved', 'rejected', 'suspended'].includes(status), '잘못된 상태입니다.');
  q.update('seller_profiles', userId, { status, review_note: str(note, 1000), reviewed_by: admin.id, reviewed_at: clock.iso() }, 'user_id');
  audit(admin, 'seller.review', 'user', userId, { status, note });
  notify(userId, `판매자 심사 결과: ${{ approved: '승인', rejected: '반려', suspended: '정지' }[status]}`, str(note, 300), '/my/seller');
}

// 정산 계좌 등록·변경: 비밀번호 재확인 + 알림 + 변경 직후 지급 보류
function setBankAccount(user, { bank, account, holder }) {
  must(recentlyReauthed(user), '정산 계좌를 바꾸려면 비밀번호를 다시 확인해야 합니다.', 403, 'REAUTH_REQUIRED');
  const acct = str(account, 40).replace(/[^0-9]/g, '');
  must(str(bank, 30) && acct.length >= 8 && str(holder, 40), '은행, 계좌번호, 예금주를 정확히 입력하세요.');
  const had = q.get("SELECT 1 FROM seller_bank_accounts WHERE seller_id = ? AND status = 'active'", user.id);
  const hours = q.settingInt('bank_change_hold_hours');
  q.tx(() => {
    q.run("UPDATE seller_bank_accounts SET status = 'replaced' WHERE seller_id = ? AND status = 'active'", user.id);
    q.insert('seller_bank_accounts', { seller_id: user.id, bank: str(bank, 30), account_enc: storage.encryptText(acct), account_last4: acct.slice(-4), holder: str(holder, 40),
      payout_hold_until: had ? new Date(clock.now().getTime() + hours * 3600000).toISOString() : null, created_at: clock.iso() });
  });
  audit(user, 'bank.change', 'user', user.id, { bank, last4: acct.slice(-4), replaced: !!had });
  notify(user.id, '정산 계좌가 변경되었습니다', had ? `본인이 변경하지 않았다면 즉시 고객지원에 알려 주세요. 변경 후 ${hours}시간 동안 지급이 보류됩니다.` : '정산 계좌가 등록되었습니다.', '/my/payouts');
}

// 회원 탈퇴. 진행 중 거래가 있으면 막고, 판매자의 기존 주문 납품물은 보관 정책에 따라 유지한다.
function withdraw(user) {
  const active = q.get(`SELECT COUNT(*) c FROM orders WHERE (buyer_id = ? OR seller_id = ?) AND payment_status IN ('pending','paid','partially_refunded')
    AND payout_status NOT IN ('paid') AND refund_status <> 'completed'`, user.id, user.id).c;
  must(active === 0, `진행 중인 거래 ${active}건이 끝난 뒤 탈퇴할 수 있습니다.`, 409);
  q.tx(() => {
    q.run("UPDATE products SET status = 'deleted', updated_at = ? WHERE seller_id = ?", clock.iso(), user.id);
    q.run("UPDATE ip_listings SET status = 'deleted' WHERE seller_id = ? AND status <> 'sold'", user.id);
    q.update('users', user.id, { status: 'withdrawn', withdrawn_at: clock.iso(), email: `withdrawn-${user.id}@deleted.invalid`, phone: '', totp_secret: null });
    q.run('DELETE FROM sessions WHERE user_id = ?', user.id);
  });
  audit(user, 'user.withdraw', 'user', user.id);
}

function ensureAdmin(email, password) {
  if (!email || !password) return;
  let u = q.get('SELECT * FROM users WHERE email = ?', email);
  if (!u) u = register({ email, password, name: '최고관리자' });
  q.run("INSERT OR IGNORE INTO staff_roles (user_id, role, granted_at) VALUES (?, 'super', ?)", u.id, clock.iso());
}
module.exports = { register, login, createSession, sessionUser, destroySession, reauth, recentlyReauthed, totp, totpBegin, totpVerify, totpOk, applySeller, reviewSeller, setBankAccount, withdraw, ensureAdmin, hashPw };
