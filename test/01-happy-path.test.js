'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helper');
const access = require('../src/services/access');
const inspection = require('../src/services/inspection');
const settlement = require('../src/services/settlement');
const ledger = require('../src/services/ledger');
const reconcile = require('../src/services/reconcile');
const storage = require('../src/storage');

beforeEach(h.reset);

test('완성형 소스 상품: 등록 → 결제 → 전달 → 검수 → 정산', async () => {
  const admin = h.staff('super');
  const s = h.seller(admin);
  const buyer = h.user('buyer');
  const { pid, optId, vid } = await h.sourceProduct(s, admin, { price: 500000 });

  const { order } = await h.buy(buyer, pid, optId);
  assert.equal(order.payment_status, 'paid');
  assert.equal(order.protection_status, 'simulated', '테스트 결제는 보호 상태를 시뮬레이션으로만 표시');
  assert.equal(order.delivery_status, 'delivered');
  assert.equal(order.inspection_status, 'in_progress');
  assert.equal(order.version_id, vid);
  assert.equal(order.fee_amount, 50000);

  // 구매확정 없이 바로 다운로드할 수 있어야 한다.
  const snap = JSON.parse(order.snapshot_json);
  const f = snap.terms.version.files.find((x) => x.role === 'source');
  const token = access.issueForOrder(buyer, order.id, f.id);
  const file = access.consume(buyer, token);
  assert.equal((await storage.readAll(file)).toString(), 'console.log("hello eum")');
  assert.equal(h.order(order.id).inspection_status, 'in_progress', '다운로드만으로 검수가 끝나지 않는다');

  // 검수 전 정산 차단
  await assert.rejects(settlement.requestPayout(admin, order.id), /검수가 끝나지 않았습니다/);

  inspection.confirm(buyer, order.id, { checklist: { files: 1 } });
  assert.equal(h.order(order.id).payout_status, 'eligible');

  const po = await settlement.requestPayout(admin, order.id);
  assert.equal(po.status, 'requested', '지급 요청 접수와 지급 완료는 다르다');
  assert.equal(h.order(order.id).payout_status, 'requested');
  await settlement.tick();
  assert.equal(h.order(order.id).payout_status, 'paid');
  assert.equal(h.q.get('SELECT amount FROM payouts WHERE order_id = ?', order.id).amount, 450000);
  assert.equal(ledger.sellerPayable(order.id), 0);
  assert.equal(ledger.balance(order.id, 'pg_holding'), 50000, '플랫폼 수수료만 남는다');

  const r = await reconcile.run();
  assert.deepEqual(r.issues, []);
});
