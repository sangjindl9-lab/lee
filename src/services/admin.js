'use strict';
// 운영자 화면용 조회(읽기 전용)
const { q } = require('../db');
const { clock } = require('../util');

function queues() {
  const now = clock.iso();
  const c = (sql, ...p) => q.get(`SELECT COUNT(*) c FROM ${sql}`, ...p).c;
  return [
    ['판매자 심사', c("seller_profiles WHERE status = 'pending'"), '/admin/sellers', ['review']],
    ['상품·버전 심사', c("products p WHERE p.status = 'pending_review' OR EXISTS (SELECT 1 FROM product_versions v WHERE v.product_id = p.id AND v.status = 'submitted')"), '/admin/products', ['review']],
    ['파일 접근 실패 주문', c("orders WHERE delivery_status = 'access_failed'"), '/admin/orders?f=access_failed', ['support']],
    ['납품 기한 초과', c("orders WHERE delivery_status IN ('awaiting_seller','redelivery_requested') AND payment_status = 'paid' AND delivery_due_at IS NOT NULL AND delivery_due_at < ?", now), '/admin/orders?f=late_delivery', ['support']],
    ['검수 기한 초과', c("orders WHERE inspection_status = 'in_progress' AND inspection_due_at < ?", now), '/admin/orders?f=late_inspection', ['support']],
    ['검수 종료 심사 요청', c("orders WHERE inspection_status = 'in_progress' AND close_review_requested_at IS NOT NULL"), '/admin/orders?f=close_review', ['support']],
    ['진행 중 분쟁', c("disputes WHERE status IN ('open','admin_review','external')"), '/admin/disputes', ['support']],
    ['이의제기', c("disputes WHERE status = 'appealed'"), '/admin/disputes', ['support']],
    ['수동 지급 대기', c("payouts WHERE method = 'manual' AND status = 'created'"), '/admin/payouts', ['settlement']],
    ['결과 불명확 지급', c("payouts WHERE status = 'unknown'"), '/admin/payouts', ['settlement']],
    ['수동 환불 대기', c("refunds WHERE status = 'manual_required'"), '/admin/refunds', ['settlement']],
    ['사후 환불·회수 검토', c("orders WHERE payout_status = 'clawback_review'"), '/admin/orders?f=clawback', ['settlement', 'support']],
    ['대사 불일치', c("reconciliation_issues WHERE status = 'open'"), '/admin/reconcile', ['settlement']],
    ['신고', c("reports WHERE status IN ('open','reviewing')"), '/admin/reports', ['support', 'review']],
    ['지원 티켓', c("tickets WHERE status = 'open'"), '/admin/tickets', ['support']],
  ];
}

// 테스트 결제와 실결제를 섞지 않는다. 총 거래액과 수수료 수익은 별도 수치.
function stats(mode) {
  const ids = "(SELECT order_id FROM payments WHERE status = 'paid' AND mode = ?)";
  const s = (sql) => q.get(sql, mode).s;
  return {
    orders: q.get(`SELECT COUNT(*) s FROM payments WHERE status = 'paid' AND mode = ?`, mode).s,
    gmv: s(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status = 'paid' AND mode = ?`),
    fee: -s(`SELECT COALESCE(SUM(amount),0) s FROM ledger_entries WHERE account = 'platform_fee' AND order_id IN ${ids}`) || 0,
    refunded: s(`SELECT COALESCE(SUM(refunded_amount),0) s FROM orders WHERE id IN ${ids}`),
    paidOut: s(`SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE status = 'paid' AND order_id IN ${ids}`),
    inTransit: s(`SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE status IN ('created','requested','unknown') AND order_id IN ${ids}`),
    payable: -s(`SELECT COALESCE(SUM(amount),0) s FROM ledger_entries WHERE account = 'seller_payable' AND order_id IN ${ids}`) || 0,
  };
}
module.exports = { queues, stats };
