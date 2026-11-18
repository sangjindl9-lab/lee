'use strict';
// 화면 스모크: 주요 화면이 오류 없이 열리고, 브라우저 폼으로 구매 흐름이 끝까지 이어지는지 확인
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helper');
const http = require('./http');

let admin, s, buyer, prod;
before(async () => { h.reset(); admin = h.staff('super'); s = h.seller(admin); buyer = h.user('buyer'); prod = await h.sourceProduct(s, admin); });

test('공개 화면이 200으로 열린다', async () => {
  const c = http.client();
  for (const p of ['/', '/market', '/market?type=source&source=1&sort=price', `/products/${prod.pid}`, '/compare', `/sellers/${s.id}`, '/experts', '/guide', '/support', '/login', '/signup', '/requests', '/ip'])
    assert.equal((await c.get(p)).status, 200, p);
  assert.equal((await c.get('/my/orders')).status, 302, '비로그인은 로그인으로');
  assert.equal((await c.get('/nope')).status, 404);
});

test('폼으로 주문 → 테스트 결제 → 다운로드 → 구매확정', async () => {
  const c = http.client(buyer);
  let r = await c.post('/orders', { product_id: prod.pid, option_id: prod.optId, agreed: '1' });
  assert.match(r.location, /^\/checkout\/\d+$/);
  const oid = r.location.split('/').pop();
  assert.equal((await c.get(r.location)).status, 200);
  r = await c.post(`/checkout/${oid}/pay`);
  assert.match(r.location, /^\/sandbox-pg\/pay\//);
  assert.equal((await c.get(r.location)).status, 200);
  r = await c.post(r.location, { method: 'card', result: 'success' });
  r = await c.get(r.location);                    // /pay/return → 서버가 사업자 조회
  assert.equal(h.order(oid).payment_status, 'paid');
  const page = await c.get(`/my/orders/${oid}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /테스트 결제 — 실제 대금 보호 없음/);
  const f = JSON.parse(h.order(oid).snapshot_json).terms.version.files[0];
  r = await c.post(`/my/orders/${oid}/files/${f.id}/link`);
  assert.match(r.location, /^\/dl\//);
  const dl = await c.get(r.location);
  assert.equal(dl.status, 200);
  assert.equal((await c.get(r.location)).status, 403, '링크는 1회용');
  r = await c.post(`/my/orders/${oid}/confirm`, { c_files: '1' });
  assert.equal(h.order(oid).inspection_status, 'approved');
  for (const p of [`/orders/${oid}/document`, '/my/orders', '/my/notifications', '/my/messages', '/my/disputes', '/my/account', '/my/favorites', '/ai/draft'])
    assert.equal((await c.get(p)).status, 200, p);
  // 판매자 화면
  const sc = http.client(s);
  for (const p of ['/my/sales', `/my/sales/${oid}`, '/my/products', `/my/products/${prod.pid}`, '/my/products/new', '/my/payouts?amount=100000', '/my/seller'])
    assert.equal((await sc.get(p)).status, 200, p);
  // 타인은 주문·문서를 볼 수 없다
  const other = http.client(h.user('other'));
  assert.equal((await other.get(`/my/orders/${oid}`)).status, 404);
  assert.equal((await other.get(`/orders/${oid}/document`)).status, 404);
  assert.equal((await other.get(`/my/sales/${oid}`)).status, 404);
});

test('CSRF 토큰 없는 POST는 거절', async () => {
  const c = http.client(buyer);
  await c.get('/');
  const res = await fetch(`http://127.0.0.1:${(await http.start()).address().port}/orders`, { method: 'POST', redirect: 'manual', headers: { cookie: `eum_sid=${c.jar.eum_sid}; eum_csrf=${c.jar.eum_csrf}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'product_id=1' });
  assert.equal(res.status, 403);
});
