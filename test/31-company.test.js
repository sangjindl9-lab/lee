'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helper');
const http = require('./http');
const company = require('../src/services/company');
const orders = require('../src/services/orders');
const inspection = require('../src/services/inspection');

beforeEach(h.reset);

async function setup() {
  const admin = h.staff('super');
  const s = h.seller(admin);
  const prod = await h.sourceProduct(s, admin);
  const boss = h.user('boss'), buyer = h.user('buyer'), insp = h.user('inspector'), outsider = h.user('outsider');
  const cid = company.create(boss, { name: '이음건설', bizNo: '123-45-67890' });
  company.addMember(boss, cid, { email: buyer.email, role: 'buyer' });
  company.addMember(boss, cid, { email: insp.email, role: 'inspector' });
  return { admin, s, ...prod, boss, buyer, insp, outsider, cid };
}

test('기업 구매: 관리자 승인 없이는 주문 불가, 승인 후 1회 주문 가능', async () => {
  const { pid, optId, boss, buyer, insp, cid } = await setup();
  const order = () => orders.createProductOrder(buyer, { productId: pid, optionId: optId, agreed: true, companyId: cid });
  assert.throws(order, { code: 'APPROVAL_REQUIRED' });
  assert.throws(() => company.requestApproval(insp, { companyId: cid, productId: pid, optionId: optId }), { status: 403 }, '검수 담당자는 구매 요청 불가');
  const aid = company.requestApproval(buyer, { companyId: cid, productId: pid, optionId: optId, note: '견적 업무용' });
  assert.throws(order, { code: 'APPROVAL_REQUIRED' }, '승인 대기 중에는 주문 불가');
  assert.throws(() => company.decideApproval(buyer, aid, true), { status: 403 }, '요청자가 스스로 승인할 수 없다');
  company.decideApproval(boss, aid, true);
  const o = order();
  assert.equal(o.company_id, cid);
  assert.equal(h.q.get('SELECT status FROM purchase_approvals WHERE id = ?', aid).status, 'used');
  assert.throws(order, { code: 'APPROVAL_REQUIRED' }, '승인은 한 번만 쓸 수 있다');
  // 검수 담당자는 기업 계정으로 구매할 수 없다
  assert.throws(() => orders.createProductOrder(insp, { productId: pid, optionId: optId, agreed: true, companyId: cid }), { status: 403 });
  // 승인 절차를 끄면 구매 담당자가 바로 주문할 수 있다
  company.setRequireApproval(boss, cid, false);
  assert.equal(order().company_id, cid);
});

test('검수 담당자는 기업 주문을 검수(구매확정)할 수 있고 외부인은 주문을 볼 수 없다', async () => {
  const { pid, optId, boss, buyer, insp, outsider, cid } = await setup();
  company.decideApproval(boss, company.requestApproval(buyer, { companyId: cid, productId: pid, optionId: optId }), true);
  const o = orders.createProductOrder(buyer, { productId: pid, optionId: optId, agreed: true, companyId: cid });
  const r = await orders.startPayment(o, buyer);
  await h.sandbox.simulate(r.providerPaymentId, { result: 'success' });
  assert.throws(() => orders.loadFor(outsider, o.id), { status: 404 });
  assert.throws(() => inspection.confirm(outsider, o.id, {}), { status: 404 });
  assert.equal(orders.loadFor(insp, o.id).role, 'buyer');
  inspection.confirm(insp, o.id, { checklist: { files: true } });
  const done = h.order(o.id);
  assert.equal(done.inspection_status, 'approved');
  assert.equal(done.confirmed_by, insp.id);
});

test('구성원 관리: 관리자만 변경, 마지막 관리자는 제거 불가, 비구성원에게는 존재를 알리지 않는다', async () => {
  const { boss, buyer, insp, outsider, cid } = await setup();
  assert.throws(() => company.addMember(buyer, cid, { email: outsider.email, role: 'buyer' }), { status: 403 });
  assert.throws(() => company.addMember(outsider, cid, { email: outsider.email, role: 'admin' }), { status: 404 });
  assert.throws(() => company.removeMember(boss, cid, boss.id), { status: 409 });
  assert.throws(() => company.setRole(boss, cid, boss.id, 'buyer'), { status: 409 });
  company.setRole(boss, cid, insp.id, 'admin');
  company.removeMember(insp, cid, boss.id);
  assert.equal(company.mine(boss).length, 0);
  assert.equal(company.members(cid).length, 2);
});

test('HTTP: 기업 계정 화면과 승인 요청·처리', async () => {
  const { pid, optId, boss, buyer, outsider, cid } = await setup();
  const bc = http.client(buyer), ac = http.client(boss);
  const page = await bc.get('/my/company');
  assert.equal(page.status, 200);
  assert.match(page.text, /이음건설/);
  assert.doesNotMatch((await http.client(outsider).get('/my/company')).text, /이음건설/);
  const reqRes = await bc.post('/my/company/approvals', { company_id: String(cid), product_id: String(pid), option_id: String(optId), note: '업무용' });
  assert.equal(reqRes.flash?.type, 'ok', JSON.stringify(reqRes.flash));
  const aid = h.q.get('SELECT id FROM purchase_approvals').id;
  assert.equal((await bc.post(`/my/company/approvals/${aid}`, { approve: '1' })).flash?.type, 'error', '구매 담당자는 승인할 수 없다');
  assert.equal((await ac.post(`/my/company/approvals/${aid}`, { approve: '1' })).flash?.type, 'ok');
  const created = await bc.post('/orders', { product_id: String(pid), option_id: String(optId), agreed: '1', company_id: String(cid) });
  assert.match(created.location || '', /^\/checkout\/\d+$/);
  assert.equal((await ac.get('/my/company')).status, 200);
  const mk = await http.client(outsider).post('/my/company', { name: '새 회사' });
  assert.equal(mk.status, 303);
  assert.equal(company.mine(outsider).length, 1);
});
