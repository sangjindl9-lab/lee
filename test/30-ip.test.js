'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helper');
const http = require('./http');
const ip = require('../src/services/ip');
const orders = require('../src/services/orders');
const access = require('../src/services/access');
const inspection = require('../src/services/inspection');
const settlement = require('../src/services/settlement');
const refunds = require('../src/services/refunds');
const storage = require('../src/storage');

beforeEach(h.reset);

const LISTING = { title: '견적 프로그램 저작재산권', public_summary: '건설 견적 프로그램 일체', right_type: '컴퓨터프로그램 저작재산권', subject: '견적 프로그램 v2 소스 전체',
  holder: '홍길동', authority: '권리자 본인', deal_type: 'assignment', scope: '저작재산권 전부(2차적저작물작성권 포함)', territory: '전 세계', included_assets: '소스 저장소\n도메인', excluded_assets: '고객 DB',
  existing_sales_handling: '기존 사용권 12건은 유지하고 지원 의무는 양수인이 승계', asking_price: '3000000' };
const TERMS = { price: '3000000', inspection_days: 7, transfer_days: 7, transfer_items: [{ asset_type: 'snapshot', description: '최종 소스 스냅샷' }, { asset_type: 'service_account', description: '앱 마켓 등록 앱' }] };

async function setup(extra = {}) {
  const admin = h.staff('super');
  const s = h.seller(admin);
  const lid = ip.createListing(s, { ...LISTING, ...extra });
  const doc = ip.addDocument(s, lid, await h.file(s, '등록증.txt', '저작권 등록증 사본', 'ip_private'), '저작권 등록증');
  ip.reviewListing(admin, lid, { approve: true, note: '등록 자료 확인' });
  return { admin, s, lid, doc };
}
// 상담 → 비밀유지 합의 → 열람 승인까지
function toDataRoom(s, buyer, lid) {
  const did = ip.startDeal(buyer, lid, '인수 검토를 위해 자료 열람을 요청합니다');
  ip.proposeNda(s, did, '');
  ip.agreeNda(buyer, did);
  ip.approveAccess(s, did);
  return did;
}
async function toPaid(s, buyer, lid) {
  const did = toDataRoom(s, buyer, lid);
  ip.proposeTerms(s, did, TERMS);
  ip.agreeTerms(buyer, did);
  const o = ip.createDealOrder(buyer, did);
  const r = await orders.startPayment(o, buyer);
  await h.sandbox.simulate(r.providerPaymentId, { result: 'success' });
  return { did, order: h.order(o.id) };
}

test('비공개 자료: 비밀유지 양측 동의와 열람 승인 전에는 거부, 이후 허용하고 열람을 기록', async () => {
  const { s, lid, doc } = await setup();
  const buyer = h.user('buyer'), stranger = h.user('stranger');
  const did = ip.startDeal(buyer, lid, '인수 검토를 위해 자료 열람을 요청합니다');
  assert.throws(() => ip.requestDocument(buyer, doc), { status: 404 }, '상담만으로는 열람 불가');
  ip.proposeNda(s, did, '');
  assert.match(ip.getDeal(did).nda_text, /법률 검토 전 초안/);
  ip.agreeNda(buyer, did);
  assert.throws(() => ip.requestDocument(buyer, doc), { status: 404 }, '동의만으로는 열람 불가(권리자 승인 필요)');
  assert.throws(() => ip.approveAccess(buyer, did), { status: 403 });
  ip.approveAccess(s, did);
  const token = ip.requestDocument(buyer, doc, { ip: '10.0.0.1', headers: {} });
  const file = access.consume(buyer, token);
  assert.equal((await storage.readAll(file)).toString(), '저작권 등록증 사본');
  assert.throws(() => ip.requestDocument(stranger, doc), { status: 404 }, '거래 당사자가 아니면 거부');
  const logs = h.q.all('SELECT * FROM ip_access_logs');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].user_id, buyer.id);
  assert.equal(logs[0].deal_id, did);
  assert.ok(h.q.get("SELECT 1 FROM download_logs WHERE context = 'ip' AND result LIKE 'denied%'"), '거부된 시도도 기록');
  // 승인을 회수하면 다시 열람할 수 없다
  ip.revokeAccess(s, did);
  assert.throws(() => ip.requestDocument(buyer, doc), { status: 404 });
});

test('독점 거래: 조건 확정 시 잠금, 다른 거래는 조건 확정 불가, 취소하면 잠금 해제', async () => {
  const { s, lid } = await setup();
  const b1 = h.user('b1'), b2 = h.user('b2'), b3 = h.user('b3');
  const d1 = toDataRoom(s, b1, lid), d2 = toDataRoom(s, b2, lid);
  ip.proposeTerms(s, d1, TERMS);
  ip.proposeTerms(s, d2, TERMS);
  assert.throws(() => ip.agreeTerms(s, d1), { status: 403 }, '자신이 제안한 조건에는 동의할 수 없다');
  ip.agreeTerms(b1, d1);
  assert.equal(ip.getListing(lid).locked_deal_id, d1);
  assert.equal(h.q.all('SELECT * FROM ip_transfer_items WHERE deal_id = ?', d1).length, 2);
  assert.throws(() => ip.agreeTerms(b2, d2), { status: 409, code: 'LISTING_LOCKED' });
  assert.throws(() => ip.startDeal(b3, lid, '저도 인수를 검토하고 싶습니다'), { status: 409 }, '잠긴 매물은 새 상담도 받지 않는다');
  ip.cancelDeal(b1, d1, '조건 재검토');
  assert.equal(ip.getListing(lid).locked_deal_id, null);
  ip.agreeTerms(b2, d2);
  assert.equal(ip.getListing(lid).locked_deal_id, d2);
});

test('비독점 이용허락은 잠그지 않고, 상담 전용 매물은 조건 제안을 받지 않는다', async () => {
  const { s, lid } = await setup({ deal_type: 'nonexclusive_license' });
  const b1 = h.user('b1'), b2 = h.user('b2');
  const d1 = toDataRoom(s, b1, lid), d2 = toDataRoom(s, b2, lid);
  ip.proposeTerms(b1, d1, TERMS); ip.agreeTerms(s, d1);
  ip.proposeTerms(b2, d2, TERMS); ip.agreeTerms(s, d2);
  assert.equal(ip.getListing(lid).locked_deal_id, null);
  const c = await setup({ deal_type: 'consult' });
  const d3 = toDataRoom(c.s, b1, c.lid);
  assert.throws(() => ip.proposeTerms(b1, d3, TERMS), /상담 전용/);
});

test('결제 사업자 보류 기간을 넘는 인도·검수 일정은 조건 제안 단계에서 막는다', async () => {
  const { s, lid } = await setup();
  const did = toDataRoom(s, h.user('buyer'), lid);
  assert.throws(() => ip.proposeTerms(s, did, { ...TERMS, inspection_days: 14, transfer_days: 30 }), { code: 'SCHEDULE_CONFLICT' });
});

test('전체 흐름: 결제 → 자산 인도 → 권리 이전 절차 확인 → 구매확정 → 매물 거래 완료 · 정산 가능', async () => {
  const { admin, s, lid } = await setup();
  const buyer = h.user('buyer');
  const { did, order } = await toPaid(s, buyer, lid);
  assert.equal(order.kind, 'ip');
  assert.equal(order.payment_status, 'paid');
  assert.equal(order.delivery_status, 'awaiting_seller');
  assert.equal(order.extra_verification, 1, '권리 양도 거래는 별도 확인 대상');
  assert.equal(ip.getDeal(did).status, 'transfer');
  const snap = JSON.parse(order.snapshot_json);
  assert.match(snap.terms.deal_type_label, /소스 전달만으로는 이전되지 않음/);
  assert.equal(snap.terms.terms_hash, ip.getDeal(did).terms_hash);

  const [snapshot, account] = ip.items(did);
  assert.throws(() => ip.markItemDone(buyer, snapshot.id, { note: '받았습니다 확인' }), { status: 403 });
  const zip = await h.file(s, 'snapshot.txt', 'final source', 'delivery');
  ip.markItemDone(s, snapshot.id, { note: '최종 소스 스냅샷을 첨부했습니다', file: zip });
  assert.equal(h.order(order.id).inspection_status, 'not_started', '일부만 인도된 상태에서는 검수가 시작되지 않는다');
  // 서비스 계정 자산: 공식 이전 절차 없이는 완료 불가, 비밀번호 전달은 절차가 아니다
  assert.throws(() => ip.markItemDone(s, account.id, { note: '계정 정보를 전달했습니다' }), { code: 'OFFICIAL_PROCEDURE_REQUIRED' });
  assert.throws(() => ip.markItemDone(s, account.id, { note: '계정 정보를 전달했습니다', officialProcedure: '비밀번호를 전달했습니다 완료' }), { code: 'OFFICIAL_PROCEDURE_REQUIRED' });
  assert.throws(() => ip.markItemDone(s, snapshot.id, { note: '비밀번호 전달 완료' }), { code: 'PASSWORD_ONLY' });
  ip.markItemDone(s, account.id, { note: '앱 이전 요청을 제출했습니다', officialProcedure: '앱 마켓의 앱 이전(App Transfer) 절차로 구매자 개발자 계정에 이전 요청, 구매자 수락 후 콘솔에서 소유자 변경 확인' });
  const o2 = h.order(order.id);
  assert.equal(o2.delivery_status, 'delivered');
  assert.equal(o2.inspection_status, 'in_progress');

  // 모든 항목의 수령 확인과 권리 이전 절차 확인 전에는 구매확정 불가
  assert.throws(() => inspection.confirm(buyer, order.id), { code: 'TRANSFER_INCOMPLETE' });
  // 구매자는 인도된 첨부 파일을 주문 화면에서 받을 수 있다
  const f = orders.orderFiles(o2).find((x) => x.id === zip.id);
  assert.ok(f);
  access.consume(buyer, access.issueForOrder(buyer, order.id, zip.id));
  ip.confirmItem(buyer, snapshot.id);
  ip.confirmItem(buyer, account.id);
  assert.throws(() => inspection.confirm(buyer, order.id), { code: 'TRANSFER_INCOMPLETE' });
  assert.throws(() => ip.confirmRights(buyer, did), { status: 409 });
  ip.setRightsProcedure(s, did, '저작재산권 양도 계약서 체결, 한국저작권위원회 권리변동 등록 신청 접수');
  assert.equal(ip.getDeal(did).status, 'rights_check');
  assert.throws(() => inspection.confirm(buyer, order.id), { code: 'TRANSFER_INCOMPLETE' });
  ip.confirmRights(buyer, did);

  inspection.confirm(buyer, order.id, {});
  assert.equal(ip.getDeal(did).status, 'completed');
  const l = ip.getListing(lid);
  assert.equal(l.status, 'sold');
  assert.equal(l.locked_deal_id, did, '거래가 끝난 독점 매물은 잠금 유지');
  assert.ok(!ip.publicList().some((x) => x.id === lid));
  // 고액·권리 거래 별도 확인 전에는 정산 불가
  assert.ok(settlement.blockers(h.order(order.id)).some((b) => /별도 확인/.test(b)));
  h.q.update('orders', order.id, { extra_verified_by: admin.id, extra_verified_at: h.clock.iso() });
  assert.equal(settlement.refresh(order.id), 'eligible');
});

test('환불되면 거래가 취소되고 독점 잠금이 풀린다', async () => {
  const { admin, s, lid } = await setup();
  const buyer = h.user('buyer');
  const { did, order } = await toPaid(s, buyer, lid);
  assert.throws(() => ip.cancelDeal(buyer, did, '변심'), { status: 409 }, '결제 후에는 직접 취소 불가');
  await refunds.execute(admin, order.id, order.amount, { reason: '판매자 미인도' });
  assert.equal(h.order(order.id).payment_status, 'refunded');
  assert.equal(ip.getDeal(did).status, 'cancelled');
  const l = ip.getListing(lid);
  assert.equal(l.locked_deal_id, null);
  assert.equal(l.status, 'approved');
});

test('HTTP: 공개 화면에는 비공개 자료가 나오지 않고, 거래 화면과 운영자 심사 화면이 열린다', async () => {
  const { admin, s, lid } = await setup();
  const buyer = h.user('buyer'), stranger = h.user('stranger');
  const anon = http.client();
  const list = await anon.get('/ip');
  assert.equal(list.status, 200);
  assert.match(list.text, /견적 프로그램 저작재산권/);
  const detail = await anon.get(`/ip/${lid}`);
  assert.equal(detail.status, 200);
  assert.doesNotMatch(detail.text, /등록증\.txt/);
  assert.match(detail.text, /보증하지 않습니다/);
  const bc = http.client(buyer);
  const start = await bc.post(`/ip/${lid}/deals`, { inquiry: '인수 검토를 위해 자료 열람을 요청합니다' });
  assert.equal(start.status, 303);
  const did = h.q.get('SELECT id FROM ip_deals').id;
  const sc = http.client(s);
  assert.equal((await sc.post(`/my/ip/deals/${did}/nda`, { text: '' })).status, 303);
  assert.equal((await bc.post(`/my/ip/deals/${did}/nda/agree`, { agree: '1', nda_hash: ip.getDeal(did).nda_hash })).status, 303);
  let room = await bc.get(`/my/ip/deals/${did}`);
  assert.equal(room.status, 200);
  assert.doesNotMatch(room.text, /등록증\.txt/, '열람 승인 전에는 자료 목록도 보이지 않는다');
  await sc.post(`/my/ip/deals/${did}/access/approve`);
  room = await bc.get(`/my/ip/deals/${did}`);
  assert.match(room.text, /등록증\.txt/);
  const docId = h.q.get('SELECT id FROM ip_documents').id;
  const dl = await bc.post(`/my/ip/documents/${docId}/link`);
  assert.equal(dl.status, 303);
  assert.match(dl.location, /^\/dl\//);
  assert.equal((await http.client(stranger).post(`/my/ip/documents/${docId}/link`)).location.startsWith('/dl/'), false);
  // 조건 제안·확정·주문
  const prop = await sc.post(`/my/ip/deals/${did}/terms`, { price: '3,000,000', inspection_days: '7', transfer_days: '7', scope: '저작재산권 전부', item_type_0: 'snapshot', item_desc_0: '최종 소스 스냅샷' });
  assert.equal(prop.flash?.type, 'ok', JSON.stringify(prop.flash));
  await bc.post(`/my/ip/deals/${did}/terms/agree`, { agree: '1', terms_hash: ip.getDeal(did).terms_hash });
  assert.equal(ip.getDeal(did).status, 'terms_agreed');
  const ord = await bc.post(`/my/ip/deals/${did}/order`);
  assert.match(ord.location, /^\/checkout\/\d+$/);
  for (const [c, path] of [[sc, '/my/ip'], [sc, `/my/ip/listings/${lid}`], [sc, `/my/ip/deals/${did}`], [bc, '/my/ip'], [bc, `/my/ip/deals/${did}`], [sc, '/my/ip/new']]) {
    assert.equal((await c.get(path)).status, 200, path);
  }
  assert.equal((await http.client(stranger).get(`/my/ip/deals/${did}`)).status, 404);
  assert.equal((await http.client(stranger).get(`/my/ip/listings/${lid}`)).status, 403);
  const ac = http.client(admin);
  assert.equal((await ac.get('/admin/ip')).status, 200);
  assert.equal((await ac.get(`/admin/ip/${lid}`)).status, 200);
  assert.equal((await bc.get('/admin/ip')).status, 404, '운영자가 아니면 존재를 알리지 않는다');
});
