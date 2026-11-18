'use strict';
// 판매자 과세 유형별 세무·증빙 처리
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helper');
const { q, sandbox } = h;
const inspection = require('../src/services/inspection');
const settlement = require('../src/services/settlement');
const refunds = require('../src/services/refunds');
const reconcile = require('../src/services/reconcile');
const ledger = require('../src/services/ledger');
const accounts = require('../src/services/accounts');
const fees = require('../src/services/fees');
const tax = require('../src/services/tax');
const http = require('./http');

let admin, buyer;
beforeEach(() => { h.reset(); admin = h.staff('super'); buyer = h.user('buyer'); });
async function settle(s, price = 500000) {
  const prod = await h.sourceProduct(s, admin, { price });
  const { order } = await h.buy(buyer, prod.pid, prod.optId);
  inspection.confirm(buyer, order.id, {});
  await settlement.requestPayout(admin, order.id); await settlement.tick();
  return { order: h.order(order.id), payout: q.get('SELECT * FROM payouts WHERE order_id = ?', order.id), records: q.all('SELECT * FROM tax_records WHERE order_id = ? ORDER BY doc_type', order.id) };
}

test('개인(비사업자): 지급액 기준 3.3% 원천징수 공제, 지급명세서 기초 데이터 생성', async () => {
  const s = h.seller(admin, 'freelancer', { bizType: 'individual', taxType: 'individual' });
  const { order, payout, records } = await settle(s);
  assert.equal(payout.gross_amount, 450000);
  assert.equal(payout.withholding_income, 13500, '소득세 3%');
  assert.equal(payout.withholding_local, 1350, '지방소득세 = 소득세의 10%');
  assert.equal(payout.amount, 435150, '실제 이체액');
  assert.equal(q.get('SELECT amount FROM sandbox_payouts').amount, 435150, '사업자에도 공제 후 금액만 지급 요청');
  assert.equal(-ledger.balance(order.id, 'withholding_payable'), 14850, '원천징수 예수금');
  assert.equal(ledger.sellerPayable(order.id), 0);
  assert.equal(ledger.balance(order.id, 'pg_holding'), 50000 + 14850, '수수료와 예수금이 남는다');
  const w = records.find((r) => r.doc_type === 'withholding');
  assert.deepEqual([w.base_amount, w.income_tax, w.local_tax, w.seller_tax_type], [450000, 13500, 1350, 'individual']);
  assert.equal(records.find((r) => r.doc_type === 'fee_record').base_amount, 50000, '개인에게는 세금계산서 대상 아님으로 기록');
  assert.deepEqual((await reconcile.run()).issues, []);
});

test('법인·일반과세자: 원천징수 없음, 수수료 세금계산서(공급가액 + 부가세) 기초 데이터', async () => {
  const { payout, records } = await settle(h.seller(admin, 'corp'));
  assert.equal(payout.amount, 450000); assert.equal(payout.withholding_income, 0);
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.doc_type, 'fee_tax_invoice');
  assert.deepEqual([r.base_amount, r.supply_amount, r.vat_amount], [50000, 45455, 4545]);
  assert.equal(r.supply_amount + r.vat_amount, 50000);
});

test('간이과세자: 세금계산서 수수 대상 여부를 구분해 기록', async () => {
  const a = await settle(h.seller(admin, 'simpleA', { bizType: 'sole', taxType: 'simplified', simplifiedInvoiceOk: true }));
  assert.equal(a.records[0].doc_type, 'fee_tax_invoice'); assert.equal(a.payout.withholding_income, 0);
  h.reset(); admin = h.staff('super'); buyer = h.user('buyer');
  const b = await settle(h.seller(admin, 'simpleB', { bizType: 'sole', taxType: 'simplified' }));
  assert.equal(b.records[0].doc_type, 'fee_record'); assert.equal(b.records[0].seller_tax_type, 'simplified');
});

test('세액 절사, 부분 환불 후 원천징수, 지급 실패 시 예수금 환원', async () => {
  const s = h.seller(admin, 'freelancer', { bizType: 'individual' });
  assert.deepEqual(tax.withholding(s.id, 333333), { taxType: 'individual', income: 9990, local: 990, total: 10980, net: 322353 }, '10원 미만 절사');
  const prod = await h.sourceProduct(s, admin, { price: 500000 });
  const { order } = await h.buy(buyer, prod.pid, prod.optId);
  await refunds.execute(admin, order.id, 100000, { reason: '부분 환불' });
  inspection.confirm(buyer, order.id, {});
  sandbox.state.faults.payoutFail = true;
  assert.equal((await settlement.requestPayout(admin, order.id)).status, 'failed');
  assert.equal(ledger.balance(order.id, 'withholding_payable'), 0, '실패하면 예수금도 되돌린다');
  assert.equal(ledger.sellerPayable(order.id), 360000);
  assert.equal(q.get('SELECT COUNT(*) c FROM tax_records').c, 0, '지급 완료 전에는 증빙을 만들지 않는다');
  sandbox.state.faults = {};
  await settlement.tick(); await settlement.tick();
  const po = q.get("SELECT * FROM payouts WHERE status = 'paid'");
  assert.deepEqual([po.gross_amount, po.withholding_income, po.withholding_local, po.amount], [360000, 10800, 1080, 348120]);
  assert.equal(q.get("SELECT base_amount b FROM tax_records WHERE doc_type = 'fee_record'").b, 40000, '환불 후 남은 수수료 기준');
  assert.deepEqual((await reconcile.run()).issues, []);
});

test('예상 정산액 안내와 과세 유형 변경 통제', async () => {
  const s = h.seller(admin, 'freelancer', { bizType: 'individual' });
  const qt = fees.quote(1000000, s.id, null);
  assert.deepEqual([qt.seller_net, qt.withholding_total, qt.seller_transfer], [900000, 29700, 870300]);
  // 승인된 판매자는 스스로 과세 유형을 바꿀 수 없다(원천징수 회피 방지)
  accounts.applySeller(h.refresh(s), { displayName: 'x 스튜디오', bizType: 'corp', taxType: 'general' });
  assert.equal(q.get('SELECT tax_type t FROM seller_profiles WHERE user_id = ?', s.id).t, 'individual');
  assert.throws(() => accounts.setTaxType(admin, s.id, { taxType: 'general', note: '' }), /확인 근거/);
  accounts.setTaxType(admin, s.id, { taxType: 'general', note: '사업자등록증 확인(2026-11-18)' });
  assert.equal(fees.quote(1000000, s.id, null).withholding_total, 0);
  assert.ok(q.get("SELECT 1 FROM audit_logs WHERE action = 'seller.tax_type'"));
  // 원천징수 설정을 끄면 공제하지 않는다
  const s2 = h.seller(admin, 'free2', { bizType: 'individual' });
  q.run("UPDATE settings SET value = '0' WHERE key = 'withholding_enabled'");
  assert.equal(tax.withholding(s2.id, 450000).total, 0);
});

test('세무 증빙 화면과 CSV는 정산 권한자만', async () => {
  await settle(h.seller(admin, 'freelancer', { bizType: 'individual' }));
  const c = http.client(admin);
  const page = await c.get('/admin/tax');
  assert.equal(page.status, 200); assert.match(page.text, /13,500원/);
  const csv = await c.get('/admin/tax.csv');
  assert.equal(csv.status, 200); assert.match(csv.text, /"450000".*"13500","1350"/);
  assert.equal((await http.client(h.staff('review')).get('/admin/tax')).status, 404);
  assert.equal((await http.client(buyer).get('/admin/tax.csv')).status, 404);
  const sp = await http.client(q.get("SELECT * FROM users WHERE name = 'freelancer'")).get('/my/payouts?amount=1000000');
  assert.match(sp.text, /원천징수\(3\.3%\)/); assert.match(sp.text, /870,300원/);
});
