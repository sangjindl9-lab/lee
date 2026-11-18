'use strict';
const { q } = require('../db');
const { clock, randomId } = require('../util');

// 한 묶음의 합이 0이 아니면 기록하지 않는다.
function post(orderId, event, entries, ref = '') {
  const rows = entries.filter(([, amt]) => amt !== 0);
  const sum = rows.reduce((s, [, a]) => s + a, 0);
  if (sum !== 0) throw new Error(`원장 불균형(${event}): ${sum}`);
  const txn = randomId(8), now = clock.iso();
  for (const [account, amount] of rows) q.insert('ledger_entries', { txn, order_id: orderId, account, amount, event, ref: String(ref), created_at: now });
  return txn;
}
const balance = (orderId, account) => q.get('SELECT COALESCE(SUM(amount),0) s FROM ledger_entries WHERE order_id = ? AND account = ?', orderId, account).s;
// 대변 계정은 부호를 뒤집어 "남은 금액"으로 돌려준다.
const neg = (n) => (n === 0 ? 0 : -n);
const sellerPayable = (orderId) => neg(balance(orderId, 'seller_payable'));
const platformFee = (orderId) => neg(balance(orderId, 'platform_fee'));
const pgPassthrough = (orderId) => neg(balance(orderId, 'pg_cost_passthrough'));
module.exports = { post, balance, sellerPayable, platformFee, pgPassthrough };
