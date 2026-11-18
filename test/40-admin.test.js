'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helper');
const { client } = require('./http');
const config = require('../src/config');
const storage = require('../src/storage');
const accounts = require('../src/services/accounts');
const catalog = require('../src/services/catalog');
const disputes = require('../src/services/disputes');
const fees = require('../src/services/fees');
const nav = require('../src/views/adminnav');

beforeEach(() => { h.reset(); config.requireAdminMfa = false; });

const LIST_PAGES = ['/admin', '/admin/sellers', '/admin/products', '/admin/products?f=all', '/admin/orders', '/admin/orders?f=late_inspection', '/admin/orders?f=dispute&payout=held',
  '/admin/disputes', '/admin/payouts', '/admin/refunds', '/admin/reconcile', '/admin/fees', '/admin/fees?amount=100000', '/admin/pg', '/admin/settings', '/admin/staff', '/admin/reports', '/admin/reviews', '/admin/tickets', '/admin/audit', '/admin/audit?action=order'];

async function scenario() {
  const admin = h.staff('super');
  const s = h.seller(admin);
  const buyer = h.user('buyer');
  const prod = await h.sourceProduct(s, admin);
  const { order } = await h.buy(buyer, prod.pid, prod.optId);
  const d = await disputes.open(buyer, order.id, { reasonCode: 'not_as_described', description: '설명과 다르게 PDF 출력이 되지 않습니다', requestedOutcome: 'refund_full' });
  return { admin, s, buyer, prod, order, dispute: d };
}

test('일반 회원은 운영자 경로가 모두 404, 비로그인은 로그인으로 이동', async () => {
  const { order, dispute, prod } = await scenario();
  const member = client(h.user('member'));
  const anon = client();
  const paths = [...LIST_PAGES, `/admin/orders/${order.id}`, `/admin/disputes/${dispute.id}`, `/admin/products/${prod.pid}`];
  for (const p of paths) {
    assert.equal((await member.get(p)).status, 404, p);
    const r = await anon.get(p);
    assert.equal(r.status, 302, p);
    assert.match(r.location, /^\/login/);
  }
  // 폼 제출은 공통 오류 처리에 따라 원래 화면으로 돌아가며 거부된다
  const denied = await member.post(`/admin/disputes/${dispute.id}/resolve`, { resolution: 'release', reason: '권한 없는 사용자의 시도입니다' });
  assert.equal(denied.flash.type, 'error');
  assert.equal(disputes.getDispute(dispute.id).status, 'open');
});

test('권한별 접근 범위: 심사·정산·고객지원', async () => {
  const { order, prod, dispute } = await scenario();
  const review = client(h.staff('review')), settle = client(h.staff('settlement')), support = client(h.staff('support'));
  for (const p of ['/admin/payouts', '/admin/refunds', '/admin/fees', '/admin/reconcile', '/admin/settings', '/admin/pg', '/admin/staff', '/admin/audit', '/admin/disputes', `/admin/orders/${order.id}`]) assert.equal((await review.get(p)).status, 404, 'review ' + p);
  for (const p of ['/admin', '/admin/sellers', '/admin/products', `/admin/products/${prod.pid}`, '/admin/reports']) assert.equal((await review.get(p)).status, 200, 'review ' + p);
  for (const p of ['/admin/products', `/admin/products/${prod.pid}`, '/admin/sellers', '/admin/disputes', '/admin/settings', '/admin/audit']) assert.equal((await settle.get(p)).status, 404, 'settlement ' + p);
  for (const p of ['/admin', '/admin/payouts', '/admin/refunds', '/admin/fees', '/admin/reconcile', `/admin/orders/${order.id}`]) assert.equal((await settle.get(p)).status, 200, 'settlement ' + p);
  for (const p of ['/admin/payouts', '/admin/fees', '/admin/products', '/admin/pg']) assert.equal((await support.get(p)).status, 404, 'support ' + p);
  for (const p of ['/admin/orders', `/admin/disputes/${dispute.id}`, '/admin/tickets']) assert.equal((await support.get(p)).status, 200, 'support ' + p);
  // 메뉴도 권한에 맞게만 보인다
  assert.ok(!nav.forUser(h.staff('review')).some(([p]) => p === '/admin/payouts'));
});

test('최고관리자는 모든 운영자 화면을 볼 수 있다', async () => {
  const { admin, order, dispute, prod, buyer } = await scenario();
  h.q.insert('reports', { reporter_id: buyer.id, target_type: 'product', target_id: prod.pid, kind: 'rights_infringement', body: '타인의 소스로 보입니다', created_at: h.clock.iso() });
  const tid = h.q.insert('tickets', { user_id: buyer.id, order_id: order.id, subject: '다운로드 문의', created_at: h.clock.iso(), updated_at: h.clock.iso() });
  h.q.insert('ticket_messages', { ticket_id: tid, user_id: buyer.id, body: '링크가 만료되었습니다', created_at: h.clock.iso() });
  const c = client(admin);
  for (const p of [...LIST_PAGES, `/admin/orders/${order.id}`, `/admin/disputes/${dispute.id}`, `/admin/products/${prod.pid}`, `/admin/tickets/${tid}`]) {
    const r = await c.get(p);
    assert.equal(r.status, 200, p);
  }
  const dash = (await c.get('/admin')).text;
  assert.match(dash, /총 거래액/); assert.match(dash, /플랫폼 수수료 수익/); assert.match(dash, /테스트 결제 수치입니다/);
  const dp = (await c.get(`/admin/disputes/${dispute.id}`)).text;
  assert.match(dp, /내부 정산 보류/); assert.match(dp, /외부 지급 보류/);
  // 운영자 파일 다운로드는 감사 기록에 남는다
  const fid = JSON.parse(order.snapshot_json).terms.version.files[0].id;
  const link = await c.post(`/admin/orders/${order.id}/files/${fid}/link`);
  assert.equal(link.status, 303);
  assert.equal((await c.get(link.location)).status, 200);
  assert.ok(h.q.get("SELECT 1 FROM audit_logs WHERE action = 'file.download' AND actor_id = ?", admin.id));
  // 티켓 답변
  await c.post(`/admin/tickets/${tid}`, { body: '새 링크를 발급해 주세요', status: 'answered' });
  assert.equal(h.q.get('SELECT status FROM tickets WHERE id = ?', tid).status, 'answered');
  assert.ok(h.q.get('SELECT 1 FROM ticket_messages WHERE ticket_id = ? AND is_staff = 1', tid));
});

test('HTTP: 상품 승인, 분쟁 결정(근거 필수), 수수료 정책 변경과 기존 주문, 설정 감사 기록', async () => {
  const { admin, s, order, dispute } = await scenario();
  const c = client(admin);

  // 심사 대기 상품을 HTTP로 승인
  const pid = catalog.saveProduct(s, null, { type: 'source', title: '재고 관리', description: '설명', included: '소스', excluded: '운영', environments: 'Node 20', inspection_criteria: '실행될 것', refund_policy: '검수 기간 내' });
  catalog.saveOption(s, pid, { name: '기본', price: 100000, includes_source: 1 });
  catalog.addVersionFile(s, pid, await h.file(s, 'src.txt', 'code'), 'source');
  catalog.addVersionFile(s, pid, await h.file(s, 'INSTALL.md', '# 설치'), 'install_doc');
  catalog.submitVersion(s, pid, { label: '1.0.0' });
  catalog.submitForReview(s, pid);
  const rv = await c.post(`/admin/products/${pid}/review`, { approve: '1', note: '' });
  assert.equal(rv.flash.type, 'ok');
  assert.equal(h.q.get('SELECT status FROM products WHERE id = ?', pid).status, 'approved');

  // 분쟁 결정: 근거가 없으면 거절
  const bad = await c.post(`/admin/disputes/${dispute.id}/resolve`, { resolution: 'refund_full', reason: '' });
  assert.equal(bad.flash.type, 'error');
  assert.equal(disputes.getDispute(dispute.id).status, 'open');
  const ok = await c.post(`/admin/disputes/${dispute.id}/resolve`, { resolution: 'refund_full', reason: '검수 기준 2번의 PDF 출력이 재현되지 않음을 확인함' });
  assert.equal(ok.flash.type, 'ok');
  const d = disputes.getDispute(dispute.id);
  assert.equal(d.status, 'resolved'); assert.equal(d.resolved_by, admin.id); assert.ok(d.resolved_at);
  assert.equal(h.order(order.id).payment_status, 'refunded');

  // 수수료 정책 추가: 기존 주문의 수수료율은 그대로
  const fp = await c.post('/admin/fees', { scope: 'default', rate: '5', label: '인하' });
  assert.equal(fp.flash.type, 'ok');
  assert.equal(h.order(order.id).fee_bps, 1000);
  assert.equal(fees.quote(100000, s.id, null).fee_bps, 500);
  assert.ok(h.q.get("SELECT 1 FROM audit_logs WHERE action = 'fee_policy.create'"));

  // 설정 변경은 감사 기록에 남는다. 자동확정은 검토 확인 없이는 켤 수 없다.
  const no = await c.post('/admin/settings', { auto_confirm_enabled: '1' });
  assert.equal(no.flash.type, 'error');
  assert.equal(h.q.setting('auto_confirm_enabled'), '0');
  await c.post('/admin/settings', { appeal_days: '10', auto_confirm_enabled: '1', auto_confirm_reviewed: '1' });
  assert.equal(h.q.setting('appeal_days'), '10'); assert.equal(h.q.setting('auto_confirm_enabled'), '1');
  const log = h.q.get("SELECT * FROM audit_logs WHERE action = 'settings.update' AND target_id = 'appeal_days'");
  assert.deepEqual(JSON.parse(log.detail), { from: '7', to: '10' });
  assert.equal(log.actor_id, admin.id);

  // 실결제 모드는 필수 확인 항목 없이 켤 수 없다
  const live = await c.post('/admin/pg-live', { on: '1', confirm: '1' });
  assert.equal(live.flash.type, 'error');
  assert.equal(h.q.setting('live_mode'), '0');
  // 운영자 권한 부여
  const u = h.user('newstaff');
  await c.post('/admin/staff/grant', { email: u.email, role: 'support' });
  assert.ok(h.q.get("SELECT 1 FROM staff_roles WHERE user_id = ? AND role = 'support'", u.id));
});

test('운영자 추가 인증(TOTP)이 필수일 때', async () => {
  const admin = h.staff('super');
  config.requireAdminMfa = true;
  const c = client(admin);
  const r = await c.get('/admin');
  assert.equal(r.status, 302); assert.equal(r.location, '/admin/mfa');
  assert.equal((await c.get('/admin/mfa')).status, 200);       // 등록 키 발급
  const wrong = await c.post('/admin/mfa', { code: '000000' });
  assert.notEqual(wrong.location, '/admin');
  assert.equal((await c.get('/admin')).status, 302);
  await c.get('/admin/mfa');
  const secret = storage.decryptText(h.q.get('SELECT totp_secret FROM users WHERE id = ?', admin.id).totp_secret);
  const ok = await c.post('/admin/mfa', { code: accounts.totp(secret) });
  assert.equal(ok.location, '/admin');
  assert.equal((await c.get('/admin')).status, 200);
  // 다른 세션은 다시 인증해야 한다
  assert.equal((await client(admin).get('/admin/settings')).status, 302);
});
