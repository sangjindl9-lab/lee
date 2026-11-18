'use strict';
// 판매자 정산. 지급 "요청 접수"와 "지급 완료"를 구분하고, 응답이 불명확하면 조회 후 같은 멱등 키로만 재시도한다.
const { q } = require('../db');
const { clock, must, AppError, str } = require('../util');
const providers = require('../providers');
const orders = require('./orders');
const ledger = require('./ledger');
const { audit, notify, notifyStaff } = require('../log');

// 지급을 막는 사유 목록. 비어 있어야 지급 요청이 가능하다.
function blockers(o) {
  const b = [];
  const now = clock.iso();
  if (!['paid', 'partially_refunded'].includes(o.payment_status)) b.push('결제가 확인되지 않았습니다');
  if (o.delivery_status !== 'delivered') b.push('납품이 완료되지 않았습니다');
  if (!['approved', 'auto_approved', 'closed_by_admin'].includes(o.inspection_status)) b.push('검수가 끝나지 않았습니다');
  if (o.dispute_status === 'open') b.push('분쟁 처리 중입니다');
  if (['requested', 'processing', 'manual_required'].includes(o.refund_status)) b.push('환불 절차가 진행 중입니다');
  if (o.extra_verification && !o.extra_verified_at) b.push('고액·권리 거래 별도 확인이 끝나지 않았습니다');
  if (o.payout_hold_until && o.payout_hold_until > now) b.push('이의제기 기간 중입니다');
  const sp = q.get('SELECT status FROM seller_profiles WHERE user_id = ?', o.seller_id);
  if (!sp || !['approved'].includes(sp.status)) b.push('판매자 확인 상태가 정상이 아닙니다');
  const acct = q.get("SELECT * FROM seller_bank_accounts WHERE seller_id = ? AND status = 'active'", o.seller_id);
  if (!acct) b.push('판매자 정산 계좌가 등록되지 않았습니다');
  else if (acct.payout_hold_until && acct.payout_hold_until > now) b.push('정산 계좌 변경 후 보류 기간입니다');
  if (q.get("SELECT 1 FROM payouts WHERE order_id = ? AND status IN ('created','requested','unknown','paid')", o.id)) b.push('이미 지급되었거나 지급이 진행 중입니다');
  if (ledger.sellerPayable(o.id) <= 0) b.push('지급할 금액이 없습니다');
  return b;
}

// 지급 전 단계(not_eligible / eligible / held)의 표시 상태만 다시 계산한다.
function refresh(orderId) {
  const o = orders.getOrder(orderId);
  if (!['not_eligible', 'eligible', 'held', 'failed'].includes(o.payout_status)) return o.payout_status;
  const b = blockers(o);
  const held = o.dispute_status === 'open' || ['requested', 'processing', 'manual_required'].includes(o.refund_status);
  const next = b.length === 0 ? 'eligible' : held ? 'held' : o.payout_status === 'failed' ? 'failed' : 'not_eligible';
  if (next !== o.payout_status) q.update('orders', o.id, { payout_status: next });
  return next;
}

function reverseReservation(payout, error) {
  q.txi(() => {
    ledger.post(payout.order_id, 'payout_reversed', [['payout_in_transit', payout.amount], ['seller_payable', -payout.amount]], payout.idempotency_key);
    q.update('payouts', payout.id, { status: 'failed', last_error: str(error, 500), last_checked_at: clock.iso() });
    q.update('orders', payout.order_id, { payout_status: 'failed' });
  });
  refresh(payout.order_id);
  notifyStaff('settlement', '판매자 지급 실패', `${payout.idempotency_key}: ${error}`, `/admin/payouts`);
}
function finalizePaid(payout, ext = {}) {
  let done = false;
  q.txi(() => {
    const cur = q.get('SELECT * FROM payouts WHERE id = ?', payout.id);
    if (cur.status === 'paid' || cur.status === 'failed') return;
    ledger.post(cur.order_id, 'payout_paid', [['payout_in_transit', cur.amount], ['pg_holding', -cur.amount]], cur.idempotency_key);
    q.update('payouts', cur.id, { status: 'paid', paid_at: clock.iso(), provider_status: 'paid', provider_payout_id: ext.providerPayoutId ?? cur.provider_payout_id, last_checked_at: clock.iso() });
    const o = orders.getOrder(cur.order_id);
    q.update('orders', cur.order_id, { payout_status: 'paid', protection_status: o.protection_status === 'held' ? 'released' : o.protection_status });
    done = true;
  });
  if (done) notify(payout.seller_id, '정산이 지급 완료되었습니다', `${payout.amount.toLocaleString('ko-KR')}원`, '/my/payouts');
}

// 지급 요청. ① DB 트랜잭션에서 조건 확인과 금액 예약 → ② 사업자 호출 → ③ 결과 반영
async function requestPayout(actor, orderId) {
  const caps = providers.caps();
  let payout;
  q.txi(() => {
    const o = orders.getOrder(orderId);
    must(o, '주문을 찾을 수 없습니다.', 404);
    const b = blockers(o);
    if (b.length) throw new AppError('지급할 수 없습니다: ' + b.join(', '), 409, 'PAYOUT_BLOCKED');
    const amount = ledger.sellerPayable(o.id);
    const n = q.get('SELECT COUNT(*) c FROM payouts WHERE order_id = ?', o.id).c + 1;
    const acct = q.get("SELECT id FROM seller_bank_accounts WHERE seller_id = ? AND status = 'active'", o.seller_id);
    const id = q.insert('payouts', {
      order_id: o.id, seller_id: o.seller_id, bank_account_id: acct.id, amount, status: 'created',
      method: caps.payout_api ? 'provider' : 'manual', idempotency_key: `po_${o.order_no}_${n}`, created_by: actor?.id ?? null, created_at: clock.iso(),
    });
    ledger.post(o.id, 'payout_reserved', [['seller_payable', amount], ['payout_in_transit', -amount]], `po_${o.order_no}_${n}`);
    q.update('orders', o.id, { payout_status: 'requested' });
    payout = q.get('SELECT * FROM payouts WHERE id = ?', id);
  });
  audit(actor, 'payout.request', 'payout', payout.id, { order_id: orderId, amount: payout.amount, method: payout.method });
  if (payout.method === 'manual') {
    notifyStaff('settlement', '수동 지급이 필요합니다', `${payout.idempotency_key} · ${payout.amount.toLocaleString('ko-KR')}원 (지급 API 미연동)`, '/admin/payouts');
    return payout;
  }
  return send(payout);
}

async function send(payout) {
  const pay = q.get("SELECT * FROM payments WHERE order_id = ? AND status = 'paid'", payout.order_id);
  const provider = providers.byName(pay.provider);
  q.run('UPDATE payouts SET attempts = attempts + 1, requested_at = COALESCE(requested_at, ?) WHERE id = ?', clock.iso(), payout.id);
  try {
    // 실제 지급 가능 잔액 확인
    const ext = await provider.getPayment(pay.provider_payment_id);
    if (ext.payable != null && ext.payable < payout.amount && ext.paidOut === 0) throw new provider.ProviderError('INSUFFICIENT_BALANCE', `사업자 지급 가능 잔액 부족(${ext.payable})`);
    const r = await provider.requestPayout({ idempotencyKey: payout.idempotency_key, providerPaymentId: pay.provider_payment_id, amount: payout.amount });
    if (r.status === 'paid') finalizePaid(payout, r);
    else q.update('payouts', payout.id, { status: 'requested', provider_payout_id: r.providerPayoutId, provider_status: 'accepted' });
  } catch (e) {
    if (e.unknown) {
      // 응답이 불명확: 실패로 단정하지 않는다. 조회 작업이 결과를 확인한다.
      q.update('payouts', payout.id, { status: 'unknown', last_error: str(e.message, 300) });
      q.update('orders', payout.order_id, { payout_status: 'unknown' });
    } else reverseReservation(payout, `${e.code || 'ERROR'}: ${e.message}`);
  }
  return q.get('SELECT * FROM payouts WHERE id = ?', payout.id);
}

// 접수·불명확 상태의 지급을 사업자에 조회해 확정한다.
async function poll(payoutId) {
  const payout = q.get('SELECT * FROM payouts WHERE id = ?', payoutId);
  if (!payout || !['requested', 'unknown'].includes(payout.status) || payout.method !== 'provider') return payout;
  const pay = q.get("SELECT * FROM payments WHERE order_id = ? AND status = 'paid'", payout.order_id);
  const provider = providers.byName(pay.provider);
  let r;
  try { r = await provider.getPayout({ idempotencyKey: payout.idempotency_key }); } catch { return payout; }
  q.update('payouts', payout.id, { last_checked_at: clock.iso(), provider_status: r.status });
  if (r.status === 'paid') finalizePaid(payout, r);
  else if (r.status === 'failed') reverseReservation(payout, '사업자가 지급 실패로 응답');
  else if (r.status === 'not_found' && payout.status === 'unknown') {
    // 사업자에 기록이 없을 때만 같은 멱등 키로 다시 요청한다.
    if (payout.attempts >= 5) { notifyStaff('settlement', '지급 상태 확인 필요', payout.idempotency_key, '/admin/payouts', `po_stuck:${payout.id}`); return payout; }
    return send(payout);
  } else if (r.status === 'accepted' && payout.status === 'unknown') {
    q.update('payouts', payout.id, { status: 'requested', provider_payout_id: r.providerPayoutId });
    q.update('orders', payout.order_id, { payout_status: 'requested' });
  }
  return q.get('SELECT * FROM payouts WHERE id = ?', payout.id);
}

// 지급 API가 없을 때: 운영자가 계좌이체 후 증빙을 남겨 완료 처리
function markManualPaid(admin, payoutId, evidence) {
  const p = q.get('SELECT * FROM payouts WHERE id = ?', payoutId);
  must(p && p.method === 'manual' && p.status === 'created', '수동 지급 대기 건이 아닙니다.', 409);
  must(str(evidence).length >= 5, '이체 증빙(이체일시·거래번호 등)을 적어 주세요.');
  q.update('payouts', p.id, { manual_evidence: str(evidence, 1000) });
  finalizePaid(p);
  audit(admin, 'payout.manual_paid', 'payout', p.id, { evidence: str(evidence, 1000) });
}
function cancelManual(admin, payoutId, reason) {
  const p = q.get('SELECT * FROM payouts WHERE id = ?', payoutId);
  must(p && p.method === 'manual' && p.status === 'created', '수동 지급 대기 건이 아닙니다.', 409);
  reverseReservation(p, '운영자 취소: ' + str(reason, 200));
  audit(admin, 'payout.manual_cancel', 'payout', p.id, { reason });
}

// 주기 작업
async function tick({ force = false } = {}) {
  for (const p of q.all("SELECT id FROM payouts WHERE status IN ('requested','unknown') AND method = 'provider'")) await poll(p.id);
  for (const o of q.all("SELECT id FROM orders WHERE payout_status IN ('not_eligible','held','failed') AND payment_status IN ('paid','partially_refunded')")) refresh(o.id);
  const cycle = q.setting('settlement_cycle');
  const kstDay = new Date(clock.now().getTime() + 9 * 3600000).getUTCDay();
  if (!force && cycle === 'weekly' && kstDay !== 1) return;
  for (const o of q.all("SELECT id FROM orders WHERE payout_status = 'eligible'")) {
    try { await requestPayout(null, o.id); } catch (e) { if (e.code !== 'PAYOUT_BLOCKED') throw e; refresh(o.id); }
  }
}
module.exports = { blockers, refresh, requestPayout, poll, markManualPaid, cancelManual, tick, finalizePaid };
