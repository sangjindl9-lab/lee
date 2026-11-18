'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helper');
const http = require('./http');
const P = require('../src/services/projects');
const orders = require('../src/services/orders');
const deliveries = require('../src/services/deliveries');
const inspection = require('../src/services/inspection');
const settlement = require('../src/services/settlement');

beforeEach(h.reset);

const MS = [
  { title: '요구사항 및 화면 설계', deliverables: '화면 설계서', amount: 300000, days: 7, criteria: '설계서 승인' },
  { title: '최종 소스·문서·배포 인도', deliverables: '전체 소스\n설치 문서', amount: 700000, days: 10, criteria: '설치 문서대로 실행', requires_source: '1' },
];
// 의뢰 → 제안 → 선택 → 구매자 동의까지
function contracted({ milestones = MS } = {}) {
  const admin = h.staff('super');
  const seller = h.seller(admin);
  const buyer = h.user('buyer');
  const req = P.createRequest(buyer, { title: '견적 관리 프로그램', requirements: '견적서 작성과 PDF 출력 기능이 필요합니다', source_terms: '최종 단계에 소스 인도', rights_terms: '이용허락' });
  const prop = P.propose(seller, req.id, { scope: '견적 작성·PDF 출력 기능 개발', exclusions: '서버 운영', revision_scope: '단계별 2회', milestones });
  const c = P.acceptProposal(buyer, prop.id);
  const v1 = P.versionsOf(c.id)[0];
  return { admin, seller, buyer, req, prop, contract: c, v1 };
}
async function pay(buyer, order) {
  const r = await orders.startPayment(order, buyer);
  await h.sandbox.simulate(r.providerPaymentId, { result: 'success', method: 'card' });
  return h.order(order.id);
}
const ms = (cid) => P.milestonesOf(cid);
// 같은 이름의 필드가 여러 번 나오는 폼(배열 필드) 제출
async function postPairs(client, path, pairs) {
  const server = await http.start();
  if (!client.jar.eum_csrf) await client.get('/requests');
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + path, { method: 'POST', redirect: 'manual', body: new URLSearchParams([['_csrf', client.jar.eum_csrf], ...pairs]),
    headers: { cookie: Object.entries(client.jar).map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded', referer: base + '/' } });
  const fc = res.headers.getSetCookie().find((c) => c.startsWith('eum_flash='));
  return { status: res.status, location: res.headers.get('location'), flash: fc ? JSON.parse(decodeURIComponent(fc.split(';')[0].slice(10))) : null };
}

test('의뢰 → 제안 → 계약 동의 → 1단계 결제 → 납품 → 검수 승인 → 2단계 결제 대기', async () => {
  const { seller, buyer, admin, contract, v1, req } = contracted();
  assert.equal(contract.status, 'draft');
  assert.equal(v1.status, 'proposed');
  assert.ok(v1.seller_agreed_at && !v1.buyer_agreed_at, '판매자 제안이므로 판매자 동의만 기록');
  assert.equal(ms(contract.id).length, 0, '양측 동의 전에는 단계가 만들어지지 않는다');
  assert.equal(P.getRequest(req.id).status, 'contracting');

  assert.equal(P.agreeVersion(buyer, v1.id).status, 'agreed');
  assert.equal(P.getContract(contract.id).status, 'active');
  let [m1, m2] = ms(contract.id);
  assert.deepEqual([m1.status, m2.status], ['awaiting_payment', 'pending']);

  // 이전 단계 미승인 시 다음 단계 결제 불가
  assert.throws(() => P.createMilestoneOrder(buyer, m2.id), /1단계의 검수가 승인된 뒤/);

  const o1 = P.createMilestoneOrder(buyer, m1.id);
  assert.equal(o1.kind, 'milestone');
  assert.equal(o1.amount, 300000);
  assert.equal(P.createMilestoneOrder(buyer, m1.id).id, o1.id, '미결제 주문은 재사용');
  const snap = JSON.parse(o1.snapshot_json);
  assert.equal(snap.terms.contract_hash, P.getVersion(v1.id).terms_hash);

  // 결제 전에는 납품 등록 불가
  assert.throws(() => deliveries.draft(seller, o1.id), /결제가 확인된 뒤/);

  const paid = await pay(buyer, o1);
  assert.equal(paid.payment_status, 'paid');
  assert.equal(paid.delivery_status, 'awaiting_seller');
  assert.equal(paid.inspection_status, 'not_started', '납품 전에는 검수가 시작되지 않는다');
  assert.equal(ms(contract.id)[0].status, 'in_progress');
  await assert.rejects(settlement.requestPayout(admin, o1.id), /납품이 완료되지 않았습니다/);

  deliveries.addFile(seller, o1.id, await h.file(seller, '화면설계서.md', '# 화면 설계', 'delivery'), 'guide');
  deliveries.submit(seller, o1.id, { note: '1단계 산출물' });
  assert.equal(h.order(o1.id).inspection_status, 'in_progress');
  assert.equal(ms(contract.id)[0].status, 'delivered');

  inspection.confirm(buyer, o1.id, {});
  [m1, m2] = ms(contract.id);
  assert.deepEqual([m1.status, m2.status], ['approved', 'awaiting_payment']);
  assert.equal(h.order(o1.id).payout_status, 'eligible');
  assert.equal(P.getContract(contract.id).status, 'active');

  // 마지막 단계까지 끝나면 계약 완료
  const o2 = await pay(buyer, P.createMilestoneOrder(buyer, m2.id));
  deliveries.addFile(seller, o2.id, await h.file(seller, 'source.txt', 'console.log(1)', 'delivery'), 'source');
  deliveries.addFile(seller, o2.id, await h.file(seller, 'INSTALL.md', '# 설치', 'delivery'), 'install_doc');
  deliveries.submit(seller, o2.id, {});
  inspection.confirm(buyer, o2.id, {});
  assert.equal(P.getContract(contract.id).status, 'completed');
  assert.equal(P.getRequest(req.id).status, 'closed');
});

test('소스 인도 단계: 스크린샷만으로는 제출 거부, 빈 파일 거부, 누락 파일 안내', async () => {
  const { seller, buyer, contract, v1 } = contracted({ milestones: [MS[1]] });
  P.agreeVersion(buyer, v1.id);
  const o = await pay(buyer, P.createMilestoneOrder(buyer, ms(contract.id)[0].id));

  await assert.rejects(h.file(seller, 'empty.zip', Buffer.alloc(0), 'delivery'), /빈 파일/);

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), Buffer.from('fake image')]);
  deliveries.addFile(seller, o.id, await h.file(seller, 'screenshot.png', png, 'delivery'), 'source');
  assert.throws(() => deliveries.submit(seller, o.id, {}), (e) => {
    assert.equal(e.code, 'DELIVERY_INCOMPLETE');
    assert.match(e.message, /화면 캡처·영상·문서만으로는/);
    assert.match(e.message, /필수 파일 누락: 설치 설명서/);
    return true;
  });
  assert.equal(h.order(o.id).delivery_status, 'awaiting_seller');
  assert.equal(h.order(o.id).inspection_status, 'not_started');
  const d = h.q.get('SELECT * FROM deliveries WHERE order_id = ?', o.id);
  assert.ok(JSON.parse(d.missing_json).length >= 2, '누락 내역이 납품 기록에 남는다');

  // 실행 파일만 올린 경우: 소스 누락
  deliveries.removeFile(seller, o.id, deliveries.filesOf(d.id)[0].id);
  deliveries.addFile(seller, o.id, await h.file(seller, 'app.exe', Buffer.from([0x4d, 0x5a, 0, 1, 2, 3]), 'delivery'), 'executable');
  assert.throws(() => deliveries.submit(seller, o.id, {}), /필수 파일 누락: 소스코드/);

  deliveries.addFile(seller, o.id, await h.file(seller, 'src.txt', 'const a = 1;', 'delivery'), 'source');
  deliveries.addFile(seller, o.id, await h.file(seller, 'INSTALL.md', '# 설치 방법', 'delivery'), 'install_doc');
  deliveries.submit(seller, o.id, {});
  assert.equal(h.order(o.id).delivery_status, 'delivered');
  // 제출된 납품의 파일 목록은 바꿀 수 없다.
  assert.throws(() => h.q.run('DELETE FROM delivery_files WHERE delivery_id = ?', d.id), /DELIVERY_FROZEN/);
});

test('수정 요청의 범위 분류와 변경 계약', async () => {
  const { seller, buyer, contract, v1 } = contracted();
  P.agreeVersion(buyer, v1.id);
  const [m1, m2] = ms(contract.id);
  const o1 = await pay(buyer, P.createMilestoneOrder(buyer, m1.id));
  deliveries.addFile(seller, o1.id, await h.file(seller, '설계서.md', '# 설계', 'delivery'), 'guide');
  deliveries.submit(seller, o1.id, {});

  // 범위 밖 요청 → 추가 개발 견적 대상으로 분류
  const rv1 = inspection.requestRevision(buyer, o1.id, { criteriaRef: '설계서', content: '모바일 앱 화면도 추가해 주세요' });
  inspection.respondRevision(seller, rv1, { scopeClass: 'out_of_scope', response: '모바일 앱은 제외 범위입니다. 추가 견적이 필요합니다' });
  assert.equal(h.q.get('SELECT * FROM revision_requests WHERE id = ?', rv1).status, 'quoted');
  assert.equal(h.order(o1.id).inspection_status, 'in_progress', '범위 밖 분류는 검수를 멈추지 않는다');
  assert.equal(P.quotedRevisions(contract.id).length, 1);

  // 범위 내 요청 → 재납품 전까지 검수 중지
  const rv2 = inspection.requestRevision(buyer, o1.id, { content: '설계서의 견적 화면 항목 누락 보완' });
  inspection.respondRevision(seller, rv2, { scopeClass: 'in_scope', response: '보완해 다시 납품하겠습니다' });
  assert.equal(h.order(o1.id).delivery_status, 'redelivery_requested');
  assert.equal(h.order(o1.id).inspection_status, 'not_started');
  assert.equal(ms(contract.id)[0].status, 'revision');
  deliveries.addFile(seller, o1.id, await h.file(seller, '설계서-v2.md', '# 설계 v2', 'delivery'), 'guide');
  deliveries.submit(seller, o1.id, {});
  assert.equal(h.order(o1.id).inspection_status, 'in_progress');

  // 변경 계약: 이미 결제된 단계는 바꿀 수 없다.
  assert.throws(() => P.proposeChange(seller, contract.id, { change_summary: '1단계 금액을 올리고 싶습니다', changes: [{ seq: 1, amount: 400000, days: 7 }] }), /이미 결제되어 변경할 수 없습니다/);

  const before = P.getContract(contract.id).current_version_id;
  const v2 = P.proposeChange(seller, contract.id, {
    change_summary: '모바일 앱 화면 추가 개발과 2단계 금액 조정',
    changes: [{ seq: 2, amount: 800000, days: 12 }],
    additions: [{ title: '모바일 앱 화면', deliverables: '앱 화면 소스', amount: 500000, days: 10, criteria: '안드로이드에서 실행' }],
  });
  assert.equal(v2.kind, 'change');
  assert.ok(v2.seller_agreed_at && !v2.buyer_agreed_at);
  // 양측 동의 전에는 적용되지 않는다.
  assert.equal(P.getContract(contract.id).current_version_id, before);
  assert.equal(ms(contract.id).length, 2);
  assert.equal(ms(contract.id)[1].amount, 700000);
  assert.throws(() => P.proposeChange(buyer, contract.id, { change_summary: '다른 변경도 제안합니다 열 글자', additions: [MS[0]] }), /이미 검토 중인 변경 제안/);
  assert.equal(P.agreeVersion(seller, v2.id).status, 'proposed', '제안자만 동의한 상태로는 적용되지 않는다');

  const diff = P.diffVersions(P.termsOf(P.getVersion(before)), P.termsOf(v2));
  assert.deepEqual(diff.rows.map((x) => x.kind), ['same', 'changed', 'added']);
  assert.equal(diff.totalAfter - diff.totalBefore, 600000);

  assert.equal(P.agreeVersion(buyer, v2.id).status, 'agreed');
  const after = ms(contract.id);
  assert.equal(after.length, 3);
  assert.equal(after[1].amount, 800000);
  assert.equal(after[1].days, 12);
  assert.equal(after[2].added_in_version, 2);
  assert.equal(P.getContract(contract.id).current_version_id, v2.id);
  assert.equal(P.getVersion(before).status, 'superseded');
  assert.equal(h.order(o1.id).amount, 300000, '이미 결제된 단계 주문은 그대로');

  // 계약 버전 내용은 DB에서 직접 바꿀 수 없다.
  assert.throws(() => h.q.run("UPDATE contract_versions SET terms_json = '{}' WHERE id = ?", v2.id), /CONTRACT_VERSION_FROZEN/);

  // 거절된 변경은 적용되지 않는다.
  const v3 = P.proposeChange(buyer, contract.id, { change_summary: '3단계 금액을 낮춰 주세요 부탁드립니다', changes: [{ seq: 3, amount: 100000, days: 10 }] });
  P.rejectVersion(seller, v3.id);
  assert.equal(ms(contract.id)[2].amount, 500000);
  assert.equal(P.getContract(contract.id).current_version_id, v2.id);

  // 변경된 금액으로 2단계 주문이 만들어진다.
  inspection.confirm(buyer, o1.id, {});
  assert.equal(P.createMilestoneOrder(buyer, m2.id).amount, 800000);
});

test('결제 사업자가 단계별 결제를 지원하지 않으면 단계 결제를 막는다', async () => {
  const { buyer, contract, v1 } = contracted();
  P.agreeVersion(buyer, v1.id);
  h.sandbox.state.stagedPayments = false;
  assert.throws(() => P.createMilestoneOrder(buyer, ms(contract.id)[0].id), (e) => e.code === 'STAGED_UNSUPPORTED' && e.status === 409 && /대체 절차/.test(e.message));
  assert.equal(h.q.get("SELECT COUNT(*) c FROM orders WHERE kind = 'milestone'").c, 0);
});

test('권한: 비공개 의뢰 열람, 타인 계약 접근, 미승인 판매자 제안 차단', async () => {
  const admin = h.staff('super');
  const seller = h.seller(admin);
  const other = h.seller(admin, 'other');
  const buyer = h.user('buyer');
  const stranger = h.user('stranger');
  const priv = P.createRequest(buyer, { title: '비공개 의뢰', requirements: '초대한 판매자만 볼 수 있는 의뢰입니다', visibility: 'private', invited_seller_id: seller.id });
  assert.equal(P.loadRequest(seller, priv.id).id, priv.id);
  assert.throws(() => P.loadRequest(other, priv.id), /찾을 수 없습니다/);
  assert.throws(() => P.loadRequest(null, priv.id), /찾을 수 없습니다/);
  assert.equal(P.listPublic().length, 0);
  assert.throws(() => P.createRequest(buyer, { title: '초대 없음', requirements: '비공개인데 초대한 판매자가 없습니다', visibility: 'private' }), /초대할 판매자/);

  const pub = P.createRequest(buyer, { title: '공개 의뢰', requirements: '누구나 제안할 수 있는 공개 의뢰입니다' });
  assert.throws(() => P.propose(stranger, pub.id, { scope: '범위를 열 글자 이상 적습니다', milestones: [MS[0]] }), /판매자 심사가 승인된 뒤/);
  assert.throws(() => P.propose(seller, pub.id, { scope: '범위를 열 글자 이상 적습니다', milestones: [] }), /단계를 1개 이상/);
  const p1 = P.propose(seller, pub.id, { scope: '범위를 열 글자 이상 적습니다', milestones: MS });
  const p2 = P.propose(other, pub.id, { scope: '다른 판매자의 제안 범위입니다', milestones: [MS[1]] });
  assert.equal(p1.total, 1000000);
  assert.deepEqual(P.compareProposals(pub.id).map((p) => [p.total, p.milestone_count, p.total_days]), [[700000, 1, 10], [1000000, 2, 17]]);
  assert.throws(() => P.acceptProposal(stranger, p1.id), /찾을 수 없습니다/);
  const c = P.acceptProposal(buyer, p1.id);
  assert.equal(h.q.get('SELECT status FROM proposals WHERE id = ?', p2.id).status, 'declined');
  assert.throws(() => P.loadContract(other, c.id), /찾을 수 없습니다/);
  assert.throws(() => P.agreeVersion(other, P.versionsOf(c.id)[0].id), /찾을 수 없습니다/);

  // 첫 계약 조건을 거절하면 의뢰가 다시 열린다.
  P.rejectVersion(buyer, P.versionsOf(c.id)[0].id);
  assert.equal(P.getContract(c.id).status, 'cancelled');
  assert.equal(P.getRequest(pub.id).status, 'open');
});

test('HTTP: 의뢰·계약 화면과 폼 제출', async () => {
  const { seller, buyer, contract, v1, req } = contracted();
  const b = http.client(buyer), s = http.client(seller), anon = http.client();
  assert.equal((await anon.get('/requests')).status, 200);
  assert.equal((await anon.get('/requests/new')).status, 302, '로그인 필요');
  for (const path of ['/requests', '/requests/new', `/requests/${req.id}`, '/my/requests', '/my/contracts', `/my/contracts/${contract.id}`]) {
    const res = await b.get(path);
    assert.equal(res.status, 200, path);
  }
  for (const path of [`/requests/${req.id}`, '/my/requests', '/my/contracts', `/my/contracts/${contract.id}`]) assert.equal((await s.get(path)).status, 200, 'seller ' + path);
  assert.equal((await http.client(h.user('outsider')).get(`/my/contracts/${contract.id}`)).status, 404, '타인 계약은 404');

  // 구매자 동의 → 단계 결제 버튼 → 결제 전 확인 화면
  let res = await b.post(`/my/contracts/${contract.id}/versions/${v1.id}/agree`);
  assert.equal(res.status, 302);
  assert.equal(P.getContract(contract.id).status, 'active');
  const page = await b.get(`/my/contracts/${contract.id}`);
  assert.match(page.text, /이 단계 결제/);
  assert.match(page.text, /법률 검토 전 초안/);
  res = await b.post(`/my/contracts/${contract.id}/milestones/${ms(contract.id)[0].id}/pay`);
  assert.match(res.location, /^\/checkout\/\d+$/);
  assert.equal((await b.get(res.location)).status, 200);

  // 변경 계약 제안 폼(배열 필드)
  res = await postPairs(s, `/my/contracts/${contract.id}/change`, [['change_summary', '추가 단계가 필요합니다 열 글자'], ['c_seq[]', '2'], ['c_amount[]', '700000'], ['c_days[]', '10'],
    ['a_title[]', '추가 연동'], ['a_deliverables[]', '연동 모듈'], ['a_amount[]', '200,000'], ['a_days[]', '5'], ['a_criteria[]', ''], ['a_requires_source[]', '0'],
    ['a_title[]', ''], ['a_deliverables[]', ''], ['a_amount[]', ''], ['a_days[]', ''], ['a_criteria[]', ''], ['a_requires_source[]', '0']]);
  assert.equal(res.status, 302);
  assert.equal(res.flash?.type, 'ok', res.flash?.msg);
  const v2 = P.versionsOf(contract.id)[0];
  assert.equal(v2.kind, 'change');
  assert.equal(P.termsOf(v2).milestones.length, 3);
  assert.equal(P.termsOf(v2).total, 1200000);
  assert.match((await b.get(`/my/contracts/${contract.id}`)).text, /추가 범위/);

  // 새 의뢰 등록 폼
  res = await b.post('/requests/new', { title: 'HTTP 의뢰', requirements: '폼으로 등록하는 의뢰 내용입니다', kind: 'new', visibility: 'public', budget_max: '3,000,000' });
  assert.match(res.location, /^\/requests\/\d+$/);
  assert.match((await anon.get('/requests')).text, /HTTP 의뢰/);
});
