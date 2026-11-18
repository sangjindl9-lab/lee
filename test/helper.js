'use strict';
process.env.NODE_ENV = 'test';
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eum-test-'));
process.env.REQUIRE_ADMIN_MFA = '0';

const db = require('../src/db');
const { q } = db;
const { clock } = require('../src/util');
const storage = require('../src/storage');
const sandbox = require('../src/providers/sandbox');
const accounts = require('../src/services/accounts');
const catalog = require('../src/services/catalog');
const orders = require('../src/services/orders');
const webhooks = require('../src/services/webhooks');

let n = 0;
function reset() {
  db.resetForTest();
  sandbox.resetForTest();
  require('../src/providers').setForTest(null);
  sandbox.state.deliver = (raw, headers) => webhooks.handle('sandbox', raw, headers);
}
function user(name = 'user') {
  const u = accounts.register({ email: `${name}${++n}@test.kr`, password: 'password-1234', name });
  return accounts.sessionUser(accounts.createSession(u.id));
}
function staff(...roles) {
  const u = user('staff');
  for (const r of roles) q.run('INSERT INTO staff_roles (user_id, role, granted_at) VALUES (?,?,?)', u.id, r, clock.iso());
  return refresh(u);
}
const refresh = (u) => { const s = accounts.sessionUser(accounts.createSession(u.id)); return s; };
function seller(admin, name = 'seller') {
  let u = user(name);
  accounts.applySeller(u, { displayName: name + ' 스튜디오' });
  accounts.reviewSeller(admin, u.id, { status: 'approved', note: '확인' });
  u = refresh(u);
  accounts.setBankAccount(u, { bank: '국민', account: '123456789012', holder: name });
  return refresh(u);
}
const file = (u, name, content, purpose = 'product') => storage.saveBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), { originalName: name, uploaderId: u.id, purpose });

// 승인된 소스코드 상품 1건
async function sourceProduct(s, admin, { price = 500000, inspectionDays = 7, extra = {} } = {}) {
  const pid = catalog.saveProduct(s, null, {
    type: 'source', title: '견적서 자동화 도구', summary: '엑셀 견적서를 자동 생성', description: '설명', included: '소스 전체', excluded: '서버 운영',
    environments: 'Node 20, Windows/macOS', inspection_criteria: '설치 문서대로 실행되고 견적 PDF가 생성될 것', refund_policy: '검수 기간 내 문제 제기',
    inspection_days: inspectionDays, platform: 'web', lic_modify: 1, lic_commercial: 1, ...extra,
  });
  const optId = catalog.saveOption(s, pid, { name: '소스 포함 영구 사용', price, includes_source: 1 });
  catalog.addVersionFile(s, pid, await file(s, 'source.txt', 'console.log("hello eum")'), 'source');
  catalog.addVersionFile(s, pid, await file(s, 'INSTALL.md', '# 설치\nnpm install && npm start'), 'install_doc');
  const vid = catalog.submitVersion(s, pid, { label: '1.0.0' });
  catalog.submitForReview(s, pid);
  catalog.reviewProduct(admin, pid, { approve: true, note: '' });
  return { pid, optId, vid };
}
// 주문 생성 → 테스트 결제 성공(웹훅 → 서버 조회 → 권한 발급)
async function buy(buyer, pid, optId, { method = 'card', result = 'success' } = {}) {
  const o = orders.createProductOrder(buyer, { productId: pid, optionId: optId, agreed: true });
  const r = await orders.startPayment(o, buyer);
  await sandbox.simulate(r.providerPaymentId, { result, method });
  return { order: orders.getOrder(o.id), paymentId: r.providerPaymentId };
}
const order = (id) => orders.getOrder(id);
module.exports = { reset, user, staff, seller, refresh, file, sourceProduct, buy, order, q, clock, sandbox };
