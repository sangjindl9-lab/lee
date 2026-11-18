'use strict';
// 납품 파일 접근: 주문별 권한 확인 → 만료되는 일회용 링크 → 사용 시점에 다시 확인 → 모든 시도를 기록
const crypto = require('crypto');
const { q } = require('../db');
const { clock, addMinutes, sha256, AppError } = require('../util');
const orders = require('./orders');
const scanner = require('../scanner');
const { audit } = require('../log');

function log(user, orderId, fileId, context, result, req) {
  q.insert('download_logs', { user_id: user?.id ?? null, order_id: orderId ?? null, file_id: fileId, context, result, ip: req?.ip ?? null, user_agent: String(req?.headers?.['user-agent'] || '').slice(0, 200), created_at: clock.iso() });
}

// 주문 파일에 대한 접근 판단. 허용이면 null, 아니면 거부 사유.
function denyReason(user, order, fileId) {
  const role = orders.roleIn(order, user);
  if (!role) return '권한 없음';
  const file = orders.orderFiles(order).find((f) => f.id === Number(fileId));
  if (!file) return '이 주문의 납품 파일이 아님';
  if (role === 'seller') return null;
  if (!['paid', 'partially_refunded'].includes(order.payment_status)) return order.payment_status === 'refunded' ? '환불 완료된 주문' : '결제 미확인';
  const ent = q.get('SELECT * FROM entitlements WHERE order_id = ?', order.id);
  if (!ent || ent.status !== 'active') return '접근 권한 없음 또는 회수됨';
  if (order.delivery_status !== 'delivered') return '납품물 준비 중';
  if (file.scan === 'flagged' && !file.scan_detail.scan_override_by) return '검사에서 문제가 발견된 파일';
  return null;
}

function issue(user, { orderId = null, fileId, context }, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.insert('download_tokens', { token_hash: sha256(token), user_id: user.id, order_id: orderId, file_id: fileId, context, expires_at: addMinutes(clock.iso(), q.settingInt('download_link_minutes') || 10) });
  return token;
}

function issueForOrder(user, orderId, fileId, req) {
  const order = orders.getOrder(orderId);
  const reason = order ? denyReason(user, order, fileId) : '권한 없음';
  if (reason) {
    log(user, orderId, Number(fileId) || null, 'order', 'denied:' + reason, req);
    throw new AppError(reason === '권한 없음' ? '찾을 수 없습니다.' : `다운로드할 수 없습니다: ${reason}`, reason === '권한 없음' ? 404 : 403, 'DOWNLOAD_DENIED');
  }
  return issue(user, { orderId: order.id, fileId: Number(fileId), context: 'order' }, req);
}

// 링크 사용. 발급받은 본인만, 만료 전 1회, 주문 파일은 사용 시점의 권한을 다시 확인한다.
function consume(user, token, req) {
  const t = q.get('SELECT * FROM download_tokens WHERE token_hash = ?', sha256(String(token)));
  const fail = (reason, status = 403) => { log(user, t?.order_id, t?.file_id ?? null, t?.context || 'unknown', 'denied:' + reason, req); throw new AppError(`다운로드할 수 없습니다: ${reason}`, status, 'DOWNLOAD_DENIED'); };
  if (!t) fail('유효하지 않은 링크', 404);
  if (!user || t.user_id !== user.id) fail('링크를 발급받은 계정이 아님');
  if (t.used_at) fail('이미 사용한 링크');
  if (t.expires_at < clock.iso()) fail('만료된 링크', 410);
  if (t.context === 'order') {
    const reason = denyReason(user, orders.getOrder(t.order_id), t.file_id);
    if (reason) fail(reason);
  }
  q.run('UPDATE download_tokens SET used_at = ? WHERE token_hash = ?', clock.iso(), t.token_hash);
  const file = q.get('SELECT * FROM files WHERE id = ?', t.file_id);
  log(user, t.order_id, t.file_id, t.context, 'ok', req);
  if (t.context === 'admin') audit(user, 'file.download', 'file', t.file_id, { order_id: t.order_id }, req?.ip);
  return file;
}
module.exports = { denyReason, issue, issueForOrder, consume, log };
