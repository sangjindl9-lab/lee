'use strict';
// 대사: 플랫폼 내부 상태와 결제 사업자 상태, 원장 불변식을 비교해 불일치를 기록한다.
const { q } = require('../db');
const { clock } = require('../util');
const providers = require('../providers');
const orders = require('./orders');
const { notifyStaff } = require('../log');

function issue(found, kind, orderId, ref, internal, external) {
  found.push({ kind, orderId, ref });
  const now = clock.iso();
  const ex = q.get("SELECT id FROM reconciliation_issues WHERE kind = ? AND order_id IS ? AND ref = ? AND status = 'open'", kind, orderId, ref);
  if (ex) q.run('UPDATE reconciliation_issues SET last_seen_at = ?, internal_value = ?, external_value = ? WHERE id = ?', now, String(internal), String(external), ex.id);
  else q.insert('reconciliation_issues', { kind, order_id: orderId, ref, internal_value: String(internal), external_value: String(external), first_seen_at: now, last_seen_at: now });
}

async function run() {
  const found = [];
  let checked = 0, recovered = 0;
  // 1) 결제: 외부에서 결제됐는데 내부가 대기 중이면 복구(웹훅 유실), 나머지는 비교
  for (const pay of q.all("SELECT * FROM payments WHERE provider_payment_id IS NOT NULL AND status IN ('pending','paid')")) {
    const provider = providers.byName(pay.provider);
    let ext;
    try { ext = await provider.getPayment(pay.provider_payment_id); } catch (e) { issue(found, 'provider_unreachable', pay.order_id, pay.provider_payment_id, pay.status, e.code || e.message); continue; }
    checked++;
    if (pay.status === 'pending') {
      if (['paid', 'partially_refunded', 'refunded'].includes(ext.status)) { await orders.syncPayment(pay.id); recovered++; }
      continue;
    }
    const o = orders.getOrder(pay.order_id);
    if (ext.amount !== pay.amount) issue(found, 'amount_mismatch', o.id, pay.provider_payment_id, pay.amount, ext.amount);
    const inTransit = q.get("SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE order_id = ? AND status = 'processing'", o.id).s;
    if (ext.refunded !== o.refunded_amount && ext.refunded !== o.refunded_amount + inTransit) issue(found, 'refund_mismatch', o.id, pay.provider_payment_id, o.refunded_amount, ext.refunded);
    const paidOutInternal = q.get("SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE order_id = ? AND status = 'paid' AND method = 'provider'", o.id).s;
    if (ext.paidOut != null) {
      const pending = q.get("SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE order_id = ? AND status IN ('requested','unknown') AND method = 'provider'", o.id).s;
      if (ext.paidOut !== paidOutInternal && ext.paidOut !== paidOutInternal + pending) issue(found, 'payout_mismatch', o.id, pay.provider_payment_id, paidOutInternal, ext.paidOut);
    }
    if (o.dispute_status === 'open' && ext.escrow.state === 'RELEASED' && o.payout_status !== 'clawback_review') issue(found, 'released_during_dispute', o.id, pay.provider_payment_id, o.payout_status, ext.escrow.state);
    if (o.protection_status === 'held' && ext.escrow.state !== 'HELD' && ext.escrow.state !== 'PAYOUT_BLOCKED') issue(found, 'protection_mismatch', o.id, pay.provider_payment_id, o.protection_status, ext.escrow.state);
    // 외부 자동확정이 플랫폼 검수 종료보다 먼저 오는지
    if (ext.escrow.autoConfirmAt && o.inspection_due_at && ext.escrow.autoConfirmAt < o.inspection_due_at && o.inspection_status === 'in_progress') issue(found, 'auto_confirm_before_inspection', o.id, pay.provider_payment_id, o.inspection_due_at, ext.escrow.autoConfirmAt);
  }
  // 2) 원장 불변식
  for (const r of q.all('SELECT txn, order_id, SUM(amount) s FROM ledger_entries GROUP BY txn HAVING s <> 0')) issue(found, 'ledger_unbalanced', r.order_id, r.txn, 0, r.s);
  for (const r of q.all("SELECT order_id, SUM(amount) s FROM ledger_entries WHERE account = 'seller_payable' GROUP BY order_id HAVING s > 0")) issue(found, 'seller_payable_negative', r.order_id, 'seller_payable', 0, -r.s);
  for (const o of q.all("SELECT * FROM orders WHERE payment_status IN ('paid','partially_refunded','refunded')")) {
    const holding = q.get("SELECT COALESCE(SUM(amount),0) s FROM ledger_entries WHERE order_id = ? AND account = 'pg_holding'", o.id).s;
    const paidOut = q.get("SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE order_id = ? AND status = 'paid'", o.id).s;
    if (holding !== o.amount - o.refunded_amount - paidOut) issue(found, 'ledger_holding_mismatch', o.id, 'pg_holding', holding, o.amount - o.refunded_amount - paidOut);
  }
  // 이번 실행에서 다시 보이지 않은 자동 탐지 문제는 해소로 표시(수동 검토 항목은 제외)
  const keys = new Set(found.map((f) => `${f.kind}|${f.orderId}|${f.ref}`));
  for (const r of q.all("SELECT * FROM reconciliation_issues WHERE status = 'open' AND kind <> 'manual_refund_review'")) {
    if (!keys.has(`${r.kind}|${r.order_id}|${r.ref}`)) q.update('reconciliation_issues', r.id, { status: 'resolved', resolved_at: clock.iso(), note: (r.note ? r.note + ' / ' : '') + '재대사에서 불일치 해소 확인' });
  }
  if (found.length) notifyStaff('settlement', `대사 불일치 ${found.length}건`, found.slice(0, 3).map((f) => f.kind).join(', '), '/admin/reconcile', `recon:${clock.iso().slice(0, 13)}`);
  return { checked, recovered, issues: found };
}
module.exports = { run };
