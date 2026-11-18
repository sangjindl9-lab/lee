'use strict';
const { q } = require('../db');
const { clock, addDays, must, forbidden, str } = require('../util');
const orders = require('./orders');
const { audit, notify, notifyStaff } = require('../log');

const CHECKLIST = [
  ['files', '계약상 파일이 모두 존재하는가'],
  ['install', '설명서대로 설치 가능한가'],
  ['features', '약속한 기능이 작동하는가'],
  ['environment', '합의한 환경에서 실행 가능한가'],
  ['source', '제공하기로 한 소스가 포함되어 있는가'],
  ['docs', '필요한 문서가 있는가'],
  ['costs', '고지하지 않은 유료 의존성이 없는가'],
];
const ev = (orderId, actor, action, detail = '') => q.insert('inspection_events', { order_id: orderId, actor_id: actor?.id ?? null, action, detail, created_at: clock.iso() });

function assertInspectable(o) {
  must(o.delivery_status === 'delivered', '납품물이 전달되지 않아 검수를 진행할 수 없습니다.', 409, 'NOT_DELIVERED');
  must(o.inspection_status === 'in_progress', '검수 중인 주문이 아닙니다.', 409);
  must(o.dispute_status !== 'open', '분쟁 처리 중에는 구매확정을 할 수 없습니다.', 409);
  must(!['requested', 'processing', 'completed', 'manual_required'].includes(o.refund_status), '환불 절차가 진행 중입니다.', 409);
}
function finish(orderId, status, actor) {
  q.update('orders', orderId, { inspection_status: status, confirmed_at: clock.iso(), confirmed_by: actor?.id ?? null });
  const o = orders.getOrder(orderId);
  if (o.kind === 'milestone') q.run("UPDATE milestones SET status = 'approved' WHERE id = ?", o.milestone_id);
  require('./settlement').refresh(orderId);
  require('./projects').onOrderApproved?.(o);
  require('./ip').onOrderApproved?.(o);
}

// 구매확정(구매자 또는 구매 기업의 검수 담당자)
function confirm(user, orderId, { checklist = {}, installDone, note } = {}) {
  const { order: o, role } = orders.loadFor(user, orderId);
  if (role !== 'buyer') throw forbidden();
  assertInspectable(o);
  const terms = orders.snapshotOf(o).terms;
  if (terms.option?.includes_install) {
    must(installDone, '설치 지원이 포함된 주문입니다. 계약에서 정한 설치 완료 조건을 확인해 주세요.', 422, 'INSTALL_NOT_DONE');
    q.update('orders', o.id, { install_done_at: clock.iso() });
  }
  if (o.kind === 'ip') require('./ip').assertTransferComplete(o);
  ev(o.id, user, 'approved', JSON.stringify({ checklist, note: str(note, 1000) }));
  finish(o.id, 'approved', user);
  audit(user, 'inspection.confirm', 'order', o.id);
  notify(o.seller_id, '구매자가 구매를 확정했습니다', o.title, `/my/sales/${o.id}`);
  return orders.getOrder(o.id);
}

// 수정 요청. 계약 기준 중 어느 항목에 대한 요청인지 함께 남긴다.
function requestRevision(user, orderId, { criteriaRef, content }) {
  const { order: o, role } = orders.loadFor(user, orderId);
  if (role !== 'buyer') throw forbidden();
  must(o.delivery_status === 'delivered' && o.inspection_status === 'in_progress', '검수 중에만 수정 요청을 할 수 있습니다.', 409);
  must(str(content).length >= 5, '요청 내용을 구체적으로 적어 주세요.');
  const id = q.insert('revision_requests', { order_id: o.id, requester_id: user.id, criteria_ref: str(criteriaRef, 200), content: str(content), created_at: clock.iso() });
  ev(o.id, user, 'revision_requested', `#${id}`);
  notify(o.seller_id, '수정 요청이 접수되었습니다', o.title, `/my/sales/${o.id}`);
  return id;
}

// 판매자 답변: 계약 범위 내(수락) / 범위 외(추가 개발 견적으로 안내) / 거절
function respondRevision(user, revisionId, { scopeClass, response }) {
  const r = q.get('SELECT * FROM revision_requests WHERE id = ?', revisionId);
  const o = r && orders.getOrder(r.order_id);
  if (!o || o.seller_id !== user.id) throw forbidden();
  must(r.status === 'open', '이미 답변한 요청입니다.', 409);
  must(['in_scope', 'out_of_scope'].includes(scopeClass), '계약 범위 분류를 선택하세요.');
  must(str(response).length >= 5, '답변 내용을 적어 주세요.');
  const status = scopeClass === 'in_scope' ? 'accepted' : 'quoted';
  q.update('revision_requests', r.id, { scope_class: scopeClass, classified_by: user.id, seller_response: str(response), status, responded_at: clock.iso() });
  if (status === 'accepted' && o.kind !== 'product') {
    // 재납품이 필요한 거래: 재납품 전까지 검수 기한을 멈춘다.
    q.update('orders', o.id, { delivery_status: 'redelivery_requested', inspection_status: 'not_started', inspection_due_at: null });
    if (o.kind === 'milestone') q.run("UPDATE milestones SET status = 'revision' WHERE id = ?", o.milestone_id);
  }
  ev(o.id, user, 'revision_' + status, `#${r.id}`);
  notify(o.buyer_id, scopeClass === 'in_scope' ? '판매자가 수정 요청을 수락했습니다' : '판매자가 계약 범위 밖 요청으로 분류했습니다', '동의하지 않으면 문제 제기를 할 수 있습니다.', `/my/orders/${o.id}`);
}

// 판매자의 검수 종료 심사 요청(검수 기한이 지났는데 구매자 응답이 없을 때)
function requestCloseReview(user, orderId) {
  const o = orders.getOrder(orderId);
  if (!o || o.seller_id !== user.id) throw forbidden();
  must(o.inspection_status === 'in_progress' && o.dispute_status !== 'open', '검수 중인 주문만 요청할 수 있습니다.', 409);
  must(o.inspection_due_at && o.inspection_due_at < clock.iso(), '검수 기한이 지난 뒤에 요청할 수 있습니다.', 409);
  q.update('orders', o.id, { close_review_requested_at: clock.iso() });
  ev(o.id, user, 'close_review_requested');
  notifyStaff('support', '검수 종료 심사 요청', o.order_no, `/admin/orders/${o.id}`);
  notify(o.buyer_id, '판매자가 검수 종료 심사를 요청했습니다', '문제가 있으면 지금 문제 제기를 해 주세요.', `/my/orders/${o.id}`);
}
function closeByAdmin(admin, orderId, reason) {
  const o = orders.getOrder(orderId);
  must(o && o.inspection_status === 'in_progress' && o.delivery_status === 'delivered', '검수 중인 주문이 아닙니다.', 409);
  must(o.dispute_status !== 'open', '분쟁 중인 주문입니다.', 409);
  must(o.inspection_due_at < clock.iso(), '검수 기한이 지나지 않았습니다.', 409);
  must(str(reason).length >= 5, '처리 근거를 적어 주세요.');
  ev(o.id, admin, 'closed_by_admin', str(reason, 1000));
  finish(o.id, 'closed_by_admin', admin);
  audit(admin, 'inspection.close', 'order', o.id, { reason: str(reason, 1000) });
  notify(o.buyer_id, '검수 기간이 종료 처리되었습니다', `근거: ${str(reason, 300)}`, `/my/orders/${o.id}`);
  notify(o.seller_id, '검수 종료 심사가 승인되었습니다', o.title, `/my/sales/${o.id}`);
}

// 주기 작업: 기한 알림, (설정된 경우에만) 자동확정, 납품 지연 알림
function tick() {
  const now = clock.iso();
  const auto = q.setting('auto_confirm_enabled') === '1';
  for (const o of q.all("SELECT * FROM orders WHERE inspection_status = 'in_progress' AND dispute_status <> 'open'")) {
    if (o.inspection_due_at <= now) {
      const openRev = q.get("SELECT 1 FROM revision_requests WHERE order_id = ? AND status = 'open'", o.id);
      if (auto && !openRev && o.kind !== 'ip' && !o.extra_verification) {
        ev(o.id, null, 'auto_approved', '검수 기한 경과(운영 정책에 따른 자동확정)');
        finish(o.id, 'auto_approved', null);
        notify(o.buyer_id, '검수 기한이 지나 자동으로 구매확정되었습니다', o.title, `/my/orders/${o.id}`, `auto:${o.id}`);
        notify(o.seller_id, '검수 기한이 지나 자동확정되었습니다', o.title, `/my/sales/${o.id}`, `auto:${o.id}`);
      } else {
        notify(o.buyer_id, '검수 기한이 지났습니다', '구매확정 또는 문제 제기를 해 주세요.', `/my/orders/${o.id}`, `due:${o.id}`);
        notify(o.seller_id, '검수 기한이 지났습니다', '구매자 응답이 없으면 검수 종료 심사를 요청할 수 있습니다.', `/my/sales/${o.id}`, `due:${o.id}`);
      }
    } else if (o.inspection_due_at <= addDays(now, 2)) {
      notify(o.buyer_id, '검수 기한이 2일 이내로 남았습니다', o.title, `/my/orders/${o.id}`, `soon:${o.id}`);
    }
  }
  for (const o of q.all("SELECT * FROM orders WHERE delivery_status IN ('awaiting_seller','redelivery_requested') AND payment_status = 'paid' AND delivery_due_at IS NOT NULL")) {
    if (o.delivery_due_at <= now) {
      notify(o.seller_id, '납품 기한이 지났습니다', o.title, `/my/sales/${o.id}`, `late:${o.id}`);
      notify(o.buyer_id, '납품 기한이 지났습니다', '판매자에게 문의하거나 문제 제기(환불 요청)를 할 수 있습니다.', `/my/orders/${o.id}`, `late:${o.id}`);
      notifyStaff('support', '납품 기한 초과', o.order_no, `/admin/orders/${o.id}`, `late:${o.id}`);
    } else if (o.delivery_due_at <= addDays(now, 2)) notify(o.seller_id, '납품 기한이 2일 이내로 남았습니다', o.title, `/my/sales/${o.id}`, `latesoon:${o.id}`);
  }
}
module.exports = { CHECKLIST, confirm, requestRevision, respondRevision, requestCloseReview, closeByAdmin, tick };
