'use strict';
// 환불. 요청 → 처리 중 → (사업자 취소 성공 확인 후) 완료. 금액은 처리 시작 시 원장에서 먼저 묶는다.
const { q } = require('../db');
const { clock, must, AppError, str, bpsOf } = require('../util');
const providers = require('../providers');
const orders = require('./orders');
const ledger = require('./ledger');
const { audit, notify, notifyStaff } = require('../log');

const LIMIT_NOTICE = '환불이 완료되면 추가 다운로드가 차단됩니다. 이미 내려받은 파일은 플랫폼이 원격으로 삭제하거나 회수할 수 없으므로, 구매자는 사용을 중단하고 보유 사본을 삭제해야 합니다.';

function finalize(refundId) {
  let fullRefund = false, order;
  q.txi(() => {
    const r = q.get('SELECT * FROM refunds WHERE id = ?', refundId);
    if (r.status !== 'processing') return;
    ledger.post(r.order_id, 'refund_completed', [['refund_in_transit', r.amount], ['pg_holding', -r.amount]], r.idempotency_key);
    const o = orders.getOrder(r.order_id);
    const refunded = o.refunded_amount + r.amount;
    fullRefund = refunded >= o.amount;
    q.update('refunds', r.id, { status: 'completed', completed_at: clock.iso(), provider_status: 'done' });
    q.update('orders', o.id, { refunded_amount: refunded, payment_status: fullRefund ? 'refunded' : 'partially_refunded', refund_status: 'completed', payout_status: fullRefund ? 'not_eligible' : o.payout_status });
    if (fullRefund) {
      // 추가 다운로드 차단
      q.run("UPDATE entitlements SET status = 'revoked', revoked_at = ?, revoke_reason = '환불 완료' WHERE order_id = ?", clock.iso(), o.id);
      if (o.kind === 'milestone') q.run("UPDATE milestones SET status = 'cancelled' WHERE id = ?", o.milestone_id);
      if (o.kind === 'ip') require('./ip').onOrderRefunded(o);
    }
    order = orders.getOrder(o.id);
  });
  if (!order) return;
  notify(order.buyer_id, '환불이 완료되었습니다', fullRefund ? LIMIT_NOTICE : '부분 환불이 완료되었습니다.', `/my/orders/${order.id}`);
  notify(order.seller_id, '주문 환불이 완료되었습니다', order.title, `/my/sales/${order.id}`);
  if (!fullRefund) require('./settlement').refresh(order.id);
}
function fail(refundId, error) {
  q.txi(() => {
    const r = q.get('SELECT * FROM refunds WHERE id = ?', refundId);
    if (r.status !== 'processing') return;
    ledger.post(r.order_id, 'refund_reversed', [['refund_in_transit', r.amount], ['seller_payable', -r.seller_share], ['platform_fee', -r.fee_share], ['pg_cost_passthrough', -r.pg_fee_share]], r.idempotency_key);
    q.update('refunds', r.id, { status: 'failed', provider_status: str(error, 200) });
    q.update('orders', r.order_id, { refund_status: 'failed' });
  });
  notifyStaff('settlement', '환불 처리 실패', String(error), '/admin/refunds');
}

// 환불 실행(운영자 결정 또는 양측 합의에 따라 호출). 구매자가 직접 호출하지 못한다.
async function execute(actor, orderId, amount, { disputeId = null, reason }) {
  let refund, manual = null, clawback = false;
  const caps = providers.caps();
  q.txi(() => {
    const o = orders.getOrder(orderId);
    must(o && ['paid', 'partially_refunded'].includes(o.payment_status), '환불할 수 있는 결제 상태가 아닙니다.', 409);
    must(Number.isInteger(amount) && amount > 0 && amount <= o.amount - o.refunded_amount, '환불 금액이 올바르지 않습니다.');
    must(!q.get("SELECT 1 FROM refunds WHERE order_id = ? AND status IN ('requested','processing')", o.id), '이미 처리 중인 환불이 있습니다.', 409, 'REFUND_IN_PROGRESS');
    const livePayout = q.get("SELECT * FROM payouts WHERE order_id = ? AND status IN ('created','requested','unknown','paid')", o.id);
    if (livePayout && livePayout.status !== 'paid') throw new AppError('판매자 지급이 진행 중입니다. 지급 결과가 확인된 뒤 다시 시도하세요.', 409, 'PAYOUT_IN_FLIGHT');
    const n = q.get('SELECT COUNT(*) c FROM refunds WHERE order_id = ?', o.id).c + 1;
    const base = { order_id: o.id, dispute_id: disputeId, amount, reason: str(reason, 1000), idempotency_key: `rf_${o.order_no}_${n}`, requested_by: actor?.id ?? o.buyer_id, decided_by: actor?.id ?? null, created_at: clock.iso() };
    if (livePayout) {
      // 이미 지급된 거래: 일반 환불로 되돌릴 수 없다 → 사후 환불·회수 검토
      q.update('orders', o.id, { payout_status: 'clawback_review', refund_status: 'manual_required' });
      q.insert('refunds', { ...base, status: 'manual_required', decision_note: '이미 판매자에게 지급된 거래 — 사후 환불·회수 검토 필요' });
      clawback = true; return;
    }
    const pay = q.get("SELECT * FROM payments WHERE order_id = ? AND status = 'paid'", o.id);
    const partial = amount < o.amount;
    if (partial && !(caps.partial_refund_methods || []).includes(pay.method)) {
      q.update('orders', o.id, { refund_status: 'manual_required' });
      q.insert('refunds', { ...base, status: 'manual_required', decision_note: `결제수단(${pay.method || '미상'})이 부분 취소를 지원하지 않음 — 대체 절차 필요` });
      manual = pay.method; return;
    }
    // 환불 후 남는 거래액 기준으로 수수료를 다시 계산해 몫을 나눈다.
    const remain = o.amount - o.refunded_amount - amount;
    const feeShare = ledger.platformFee(o.id) - bpsOf(remain, o.fee_bps);
    const pgShare = o.pg_fee_bearer === 'seller' ? ledger.pgPassthrough(o.id) - bpsOf(remain, o.pg_fee_bps) : 0;
    const sellerShare = amount - feeShare - pgShare;
    must(sellerShare <= ledger.sellerPayable(o.id), '판매자 정산 잔액이 부족합니다. 사후 회수 검토가 필요합니다.', 409, 'INSUFFICIENT_PAYABLE');
    ledger.post(o.id, 'refund_reserved', [['seller_payable', sellerShare], ['platform_fee', feeShare], ['pg_cost_passthrough', pgShare], ['refund_in_transit', -amount]], base.idempotency_key);
    const id = q.insert('refunds', { ...base, status: 'processing', seller_share: sellerShare, fee_share: feeShare, pg_fee_share: pgShare });
    q.update('orders', o.id, { refund_status: 'processing', payout_status: ['eligible', 'not_eligible', 'failed'].includes(o.payout_status) ? 'held' : o.payout_status });
    refund = { ...q.get('SELECT * FROM refunds WHERE id = ?', id), pay };
  });
  audit(actor, 'refund.execute', 'order', orderId, { amount, disputeId, manual, clawback });
  if (clawback) { notifyStaff('settlement', '사후 환불·회수 검토 필요', `주문 #${orderId}`, `/admin/orders/${orderId}`); return { status: 'manual_required', clawback: true }; }
  if (manual !== null) { notifyStaff('settlement', '부분 환불 수동 처리 필요', `주문 #${orderId}`, `/admin/refunds`); return { status: 'manual_required', method: manual }; }
  const provider = providers.byName(refund.pay.provider);
  try {
    await provider.cancelPayment({ providerPaymentId: refund.pay.provider_payment_id, amount, idempotencyKey: refund.idempotency_key, reason });
    // 취소 성공을 사업자 조회로 다시 확인한 뒤 완료 처리
    const ext = await provider.getPayment(refund.pay.provider_payment_id);
    const o = orders.getOrder(orderId);
    if (ext.refunded >= o.refunded_amount + amount) finalize(refund.id);
  } catch (e) {
    if (!e.unknown) fail(refund.id, `${e.code || 'ERROR'}: ${e.message}`);
    // 불명확하면 processing으로 두고 주기 작업이 조회로 확정한다.
  }
  return q.get('SELECT * FROM refunds WHERE id = ?', refund.id);
}

// 처리 중인 환불을 사업자 조회로 확정
async function tick() {
  for (const r of q.all("SELECT * FROM refunds WHERE status = 'processing'")) {
    const pay = q.get("SELECT * FROM payments WHERE order_id = ? AND status = 'paid'", r.order_id);
    const o = orders.getOrder(r.order_id);
    try {
      const ext = await providers.byName(pay.provider).getPayment(pay.provider_payment_id);
      if (ext.refunded >= o.refunded_amount + r.amount) finalize(r.id);
      else if (clock.now() - new Date(r.created_at) > 15 * 60000) {
        // 사업자에 반영되지 않았다면 같은 멱등 키로 다시 요청
        try { await providers.byName(pay.provider).cancelPayment({ providerPaymentId: pay.provider_payment_id, amount: r.amount, idempotencyKey: r.idempotency_key, reason: r.reason }); } catch (e) { if (!e.unknown) fail(r.id, e.message); }
      }
    } catch { /* 다음 주기에 다시 */ }
  }
}

// 수동 처리(부분취소 미지원·사후 회수) 결과 기록
function recordManual(admin, refundId, { done, note }) {
  const r = q.get('SELECT * FROM refunds WHERE id = ?', refundId);
  must(r && r.status === 'manual_required', '수동 처리 대기 건이 아닙니다.', 409);
  must(str(note).length >= 5, '처리 내용과 증빙을 적어 주세요.');
  q.update('refunds', r.id, { status: done ? 'completed' : 'rejected', decided_by: admin.id, decision_note: r.decision_note + ' / ' + str(note, 1000), completed_at: done ? clock.iso() : null });
  q.update('orders', r.order_id, { refund_status: done ? 'completed' : 'rejected' });
  if (done) q.run("UPDATE entitlements SET status = 'revoked', revoked_at = ?, revoke_reason = '수동 환불 완료' WHERE order_id = ?", clock.iso(), r.order_id);
  audit(admin, 'refund.manual', 'refund', r.id, { done, note });
  const o = orders.getOrder(r.order_id);
  notify(o.buyer_id, done ? '환불이 수동 절차로 완료 처리되었습니다' : '환불 요청이 처리되지 않았습니다', str(note, 300), `/my/orders/${o.id}`);
  // 수동 환불은 사업자 장부와 플랫폼 원장이 어긋날 수 있으므로 대사에서 확인하도록 남긴다.
  q.run(`INSERT OR IGNORE INTO reconciliation_issues (kind, order_id, ref, internal_value, external_value, first_seen_at, last_seen_at) VALUES ('manual_refund_review', ?, ?, ?, '수동 처리', ?, ?)`, r.order_id, r.idempotency_key, String(r.amount), clock.iso(), clock.iso());
}

// 환불 후 구매자의 삭제·이용중단 확인
function ackTermination(user, orderId) {
  const o = orders.getOrder(orderId);
  must(o && o.buyer_id === user.id && o.payment_status === 'refunded', '환불 완료된 본인 주문만 확인할 수 있습니다.', 409);
  q.update('orders', o.id, { use_termination_ack_at: clock.iso() });
  audit(user, 'refund.use_termination_ack', 'order', o.id);
}
module.exports = { execute, finalize, tick, recordManual, ackTermination, LIMIT_NOTICE };
