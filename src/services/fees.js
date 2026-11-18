'use strict';
const { q } = require('../db');
const { clock, bpsOf } = require('../util');

// 적용 수수료율: 판매자별 > 카테고리별 > 기본. 같은 범위에서는 기간 한정(할인) 정책이 상시 정책보다 우선.
function resolveRate(sellerId, categoryId, at = clock.iso()) {
  const rows = q.all(`SELECT * FROM fee_policies WHERE (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?)`, at, at);
  const rank = (r) => (r.scope === 'seller' && r.scope_id === sellerId ? 3 : r.scope === 'category' && r.scope_id === categoryId ? 2 : r.scope === 'default' ? 1 : 0);
  const best = rows.filter((r) => rank(r) > 0)
    .sort((a, b) => rank(b) - rank(a) || (b.ends_at ? 1 : 0) - (a.ends_at ? 1 : 0) || b.id - a.id)[0];
  return best ? { bps: best.rate_bps, policyId: best.id, label: best.label || best.scope } : { bps: 0, policyId: null, label: '정책 없음' };
}

// 예상 정산액 계산(주문 시점에 이 값이 주문에 고정된다)
function quote(amount, sellerId, categoryId) {
  const rate = resolveRate(sellerId, categoryId);
  const fee = bpsOf(amount, rate.bps);
  const feeVat = q.setting('fee_vat_included') === '1' ? Math.floor(fee / 11) : 0;
  const pgBps = q.settingInt('pg_fee_bps');
  const pgFee = bpsOf(amount, pgBps);
  const bearer = q.setting('pg_fee_bearer') === 'seller' ? 'seller' : 'platform';
  return {
    amount, fee_bps: rate.bps, fee_amount: fee, fee_vat: feeVat, fee_policy_id: rate.policyId, fee_policy_label: rate.label,
    pg_fee_bps: pgBps, pg_fee_amount: pgFee, pg_fee_bearer: bearer,
    seller_net: amount - fee - (bearer === 'seller' ? pgFee : 0),
  };
}
module.exports = { resolveRate, quote };
