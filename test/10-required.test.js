'use strict';
// 요구사항 17의 필수 테스트. 각 테스트 이름이 요구 항목에 대응한다.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const h = require('./helper');
const { q, sandbox, clock } = h;
const access = require('../src/services/access');
const orders = require('../src/services/orders');
const catalog = require('../src/services/catalog');
const accounts = require('../src/services/accounts');
const inspection = require('../src/services/inspection');
const settlement = require('../src/services/settlement');
const disputes = require('../src/services/disputes');
const refunds = require('../src/services/refunds');
const reconcile = require('../src/services/reconcile');
const webhooks = require('../src/services/webhooks');
const ledger = require('../src/services/ledger');
const storage = require('../src/storage');
const scanner = require('../src/scanner');
const http = require('./http');

let admin, s, buyer, prod;
beforeEach(async () => { h.reset(); admin = h.staff('super'); s = h.seller(admin); buyer = h.user('buyer'); prod = await h.sourceProduct(s, admin, { price: 500000 }); });
const firstFile = (o) => JSON.parse(o.snapshot_json).terms.version.files.find((f) => f.role === 'source');
const paidOrder = async (opts) => (await h.buy(buyer, prod.pid, prod.optId, opts)).order;
const confirmed = async (opts) => { const o = await paidOrder(opts); inspection.confirm(buyer, o.id, {}); return h.order(o.id); };

test('1. 결제하지 않은 사용자의 파일 접근 차단', async () => {
  const o = orders.createProductOrder(buyer, { productId: prod.pid, optionId: prod.optId, agreed: true });
  const f = firstFile(o);
  assert.throws(() => access.issueForOrder(buyer, o.id, f.id), /결제 미확인/);
  // 결제창만 열고 결제하지 않은 상태, 결제 실패 상태도 차단
  const r = await orders.startPayment(o, buyer);
  assert.throws(() => access.issueForOrder(buyer, o.id, f.id), /결제 미확인/);
  await sandbox.simulate(r.providerPaymentId, { result: 'fail' });
  assert.equal(h.order(o.id).payment_status, 'failed');
  assert.throws(() => access.issueForOrder(buyer, o.id, f.id), /결제 미확인/);
  assert.equal(q.get("SELECT COUNT(*) c FROM download_logs WHERE result LIKE 'denied:%'").c, 3, '거부된 시도도 기록');
  // 브라우저가 성공 화면 주소로 직접 가도 결제 완료가 되지 않는다
  const c = http.client(buyer);
  await c.get(`/pay/return/${o.id}`);
  assert.equal(h.order(o.id).payment_status, 'failed');
});

test('2. 타인 주문과 정산 정보 접근 차단', async () => {
  const o = await paidOrder();
  const other = h.user('other'), f = firstFile(o);
  assert.throws(() => access.issueForOrder(other, o.id, f.id), /찾을 수 없습니다/);
  assert.throws(() => orders.loadFor(other, o.id), /찾을 수 없습니다/);
  // 다른 사람이 발급받은 링크를 가로채도 쓸 수 없다
  const token = access.issueForOrder(buyer, o.id, f.id);
  assert.throws(() => access.consume(other, token), /발급받은 계정이 아님/);
  // 자기 주문 번호에 남의 주문 파일 ID를 넣는 시도
  const prod2 = await h.sourceProduct(h.seller(admin, 's2'), admin);
  const o2 = (await h.buy(other, prod2.pid, prod2.optId)).order;
  assert.throws(() => access.issueForOrder(other, o2.id, f.id), /이 주문의 납품 파일이 아님/);
  const c = http.client(other);
  for (const p of [`/my/orders/${o.id}`, `/my/sales/${o.id}`, `/orders/${o.id}/document`]) assert.equal((await c.get(p)).status, 404, p);
  const page = await c.get('/my/payouts');
  assert.ok(!page.text.includes(o.order_no), '남의 정산 정보가 보이지 않는다');
  assert.equal((await c.get('/admin/payouts')).status, 404);
});

test('3. 결제 완료 후 파일 전달 실패 시 복구', async () => {
  const f0 = q.get('SELECT * FROM files ORDER BY id LIMIT 1');
  const p = storage.pathOf(f0.storage_key);
  fs.renameSync(p, p + '.lost');                       // 저장소 장애를 흉내
  const o = await paidOrder();
  assert.equal(o.payment_status, 'paid');
  assert.equal(o.delivery_status, 'access_failed');
  assert.equal(o.inspection_status, 'not_started', '납품물에 접근할 수 없으면 검수 기간을 시작하지 않는다');
  assert.equal(o.inspection_due_at, null);
  await assert.rejects(settlement.requestPayout(admin, o.id), /납품이 완료되지 않았습니다/);
  assert.throws(() => inspection.confirm(buyer, o.id, {}), /납품물이 전달되지 않아/);
  clock.advanceDays(2);
  fs.renameSync(p + '.lost', p);                       // 복구
  assert.equal(orders.retryAccess(), 1);
  const after = h.order(o.id);
  assert.equal(after.delivery_status, 'delivered');
  assert.equal(after.inspection_status, 'in_progress');
  assert.ok(after.inspection_started_at > o.paid_at, '검수 기간은 복구 시점부터');
});

test('4. 빈 파일 및 누락 파일 납품 처리', async () => {
  await assert.rejects(h.file(s, 'empty.zip', ''), /빈 파일/);
  // 소스 상품인데 실행 파일만 올린 버전은 제출할 수 없다
  const pid = catalog.saveProduct(s, null, { type: 'source', title: '누락 시험', description: 'd', included: 'i', excluded: 'e', environments: 'env', inspection_criteria: 'c', refund_policy: 'r' });
  catalog.saveOption(s, pid, { name: '기본', price: 10000 });
  assert.throws(() => catalog.submitVersion(s, pid, { label: '1.0' }), /실제 납품 파일을 등록해야/);
  catalog.addVersionFile(s, pid, await h.file(s, 'app.exe', Buffer.from([0x4d, 0x5a, 0, 1, 2, 3])), 'executable');
  assert.throws(() => catalog.submitVersion(s, pid, { label: '1.0' }), /소스코드 파일이 필요합니다.*설치 설명서가 필요합니다/);
  assert.throws(() => catalog.submitForReview(s, pid), /납품 파일 버전을 제출하세요/);
  // 비밀값·악성 시험 서명·경로 탈출 압축은 문제 발견으로 표시되고 제출이 막힌다
  const secret = await h.file(s, 'config.js', 'const db = { password: "Sup3rS3cretPw!" };\nconst k = "AKIAIOSFODNN7EXAMPLE";');
  assert.equal(secret.scan_secrets, 'flagged');
  const eicar = await h.file(s, 'tool.txt', scanner.EICAR);
  assert.equal(eicar.scan_malware, 'flagged');
  const clean = await h.file(s, 'readme.md', '# 안내');
  assert.equal(clean.scan_malware, 'unscannable', '검사 엔진이 없으면 통과가 아니라 검사 불가');
  assert.equal(scanner.overall(clean), 'unscannable');
  catalog.addVersionFile(s, pid, secret, 'source');
  catalog.addVersionFile(s, pid, clean, 'install_doc');
  assert.throws(() => catalog.submitVersion(s, pid, { label: '1.0' }), /검사에서 문제가 발견된 파일: config.js/);
});

test('4-1. 압축 폭탄·경로 탈출 방어', async () => {
  const zlib = require('zlib');
  const zip = (name, data) => {      // 최소 ZIP(deflate) 생성
    const comp = zlib.deflateRawSync(data), nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nm.length, 28);
    const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10); eo.writeUInt32LE(46 + nm.length, 12); eo.writeUInt32LE(30 + nm.length + comp.length, 16);
    return Buffer.concat([lh, nm, comp, cd, nm, eo]);
  };
  const traversal = await h.file(s, 'a.zip', zip('../../etc/cron.d/x', Buffer.from('x')));
  assert.equal(traversal.scan_archive, 'flagged');
  const bomb = await h.file(s, 'b.zip', zip('big.bin', Buffer.alloc(30 * 1024 * 1024)));
  assert.equal(bomb.scan_archive, 'flagged');
  assert.match(bomb.scan_report, /압축률이 비정상적으로 높습니다/);
  const withEnv = await h.file(s, 'c.zip', zip('app/.env', Buffer.from('DB_PASSWORD=realpassword123\n')));
  assert.equal(withEnv.scan_archive, 'passed');
  assert.equal(withEnv.scan_secrets, 'flagged');
  const ok = await h.file(s, 'd.zip', zip('app/.env.example', Buffer.from('DB_PASSWORD=\n')));
  assert.equal(ok.scan_secrets, 'passed');
});

test('5. 계약과 다른 파일로 몰래 교체 시도', async () => {
  const o = await paidOrder();
  const original = firstFile(o);
  const evil = await h.file(s, 'source.txt', 'console.log("다른 내용")');
  // 제출된 버전에는 서비스로도, DB 직접 수정으로도 파일을 넣거나 뺄 수 없다
  assert.throws(() => q.run('INSERT INTO product_version_files VALUES (?,?,?)', prod.vid, evil.id, 'source'), /VERSION_FROZEN/);
  assert.throws(() => q.run('DELETE FROM product_version_files WHERE version_id = ?', prod.vid), /VERSION_FROZEN/);
  assert.throws(() => q.run('UPDATE product_version_files SET file_id = ? WHERE version_id = ?', evil.id, prod.vid), /VERSION_FROZEN/);
  assert.throws(() => q.run('UPDATE files SET sha256 = ?, storage_key = ? WHERE id = ?', evil.sha256, evil.storage_key, original.id), /FILE_IMMUTABLE/);
  assert.throws(() => q.run('UPDATE orders SET version_id = 999 WHERE id = ?', o.id), /ORDER_TERMS_FROZEN/);
  assert.throws(() => q.run("UPDATE orders SET snapshot_json = '{}' WHERE id = ?", o.id), /ORDER_TERMS_FROZEN/);
  // 판매자가 새 버전을 올려 승인받아도 기존 주문은 주문 당시 파일을 받는다
  catalog.addVersionFile(s, prod.pid, evil, 'source');
  catalog.addVersionFile(s, prod.pid, await h.file(s, 'INSTALL.md', '# v2'), 'install_doc');
  catalog.submitVersion(s, prod.pid, { label: '2.0.0' });
  catalog.reviewProduct(admin, prod.pid, { approve: true });
  assert.notEqual(q.get('SELECT current_version_id v FROM products WHERE id = ?', prod.pid).v, prod.vid);
  const got = await storage.readAll(access.consume(buyer, access.issueForOrder(buyer, o.id, original.id)));
  assert.equal(got.toString(), 'console.log("hello eum")');
  assert.throws(() => access.issueForOrder(buyer, o.id, evil.id), /이 주문의 납품 파일이 아님/);
  // 새 주문은 새 버전으로 고정
  const o2 = (await h.buy(h.user('b2'), prod.pid, prod.optId)).order;
  assert.notEqual(o2.version_id, o.version_id);
  assert.notEqual(o2.terms_hash, o.terms_hash);
});

test('6. 판매자 탈퇴 후 기존 구매 접근', async () => {
  const o = await confirmed();
  await settlement.requestPayout(admin, o.id); await settlement.tick();
  assert.equal(h.order(o.id).payout_status, 'paid');
  accounts.withdraw(h.refresh(s));
  assert.equal(q.get('SELECT status FROM users WHERE id = ?', s.id).status, 'withdrawn');
  assert.equal(q.get('SELECT status FROM products WHERE id = ?', prod.pid).status, 'deleted');
  // 신규 구매는 막히고 기존 구매자의 접근은 유지된다
  assert.throws(() => orders.createProductOrder(h.user('new'), { productId: prod.pid, optionId: prod.optId, agreed: true }), /판매 중인 상품이 아닙니다/);
  const f = firstFile(o);
  const file = access.consume(buyer, access.issueForOrder(buyer, o.id, f.id));
  assert.equal((await storage.readAll(file)).toString(), 'console.log("hello eum")');
  assert.equal((await http.client(buyer).get(`/my/orders/${o.id}`)).status, 200);
});

test('6-1. 진행 중 거래가 있으면 탈퇴 불가, 판매 종료 후에도 접근 유지', async () => {
  const o = await paidOrder();
  assert.throws(() => accounts.withdraw(h.refresh(s)), /진행 중인 거래 1건/);
  catalog.deleteProduct(s, prod.pid);
  assert.ok(access.issueForOrder(buyer, o.id, firstFile(o).id));
});

test('7. 미납품 상태의 검수·정산 차단', async () => {
  // 판매자 납품이 필요한 주문(맞춤 개발 단계와 같은 구조)을 직접 만든다
  const o0 = orders.createOrder({ kind: 'milestone', buyer, sellerId: s.id, title: '1단계', amount: 300000, terms: { requires_source: true, seq: 1, title: '1단계' }, inspectionDays: 7, deliveryDays: 10 });
  const r = await orders.startPayment(o0, buyer);
  await sandbox.simulate(r.providerPaymentId);
  const o = h.order(o0.id);
  assert.equal(o.delivery_status, 'awaiting_seller');
  assert.equal(o.inspection_status, 'not_started');
  assert.throws(() => inspection.confirm(buyer, o.id, {}), /납품물이 전달되지 않아/);
  await assert.rejects(settlement.requestPayout(admin, o.id), /납품이 완료되지 않았습니다/);
  clock.advanceDays(40);
  inspection.tick(); await settlement.tick({ force: true });
  assert.equal(h.order(o.id).inspection_status, 'not_started', '기한이 지나도 미납품이면 검수가 시작되지 않는다');
  assert.equal(q.get('SELECT COUNT(*) c FROM payouts').c, 0);
  assert.ok(q.get("SELECT 1 FROM notifications WHERE user_id = ? AND title = '납품 기한이 지났습니다'", buyer.id), '지연 알림');
});

test('8. 분쟁 중 지급 시도', async () => {
  const o = await paidOrder();
  const d = await disputes.open(buyer, o.id, { reasonCode: 'not_as_described', description: '설명한 PDF 출력 기능이 없습니다.', requestedOutcome: 'refund_full' });
  assert.equal(d.external_hold, 'confirmed');
  assert.equal(h.order(o.id).payout_status, 'held');
  assert.equal(h.order(o.id).refund_status, 'requested', '환불 요청과 환불 완료는 다르다');
  assert.equal(h.order(o.id).payment_status, 'paid');
  assert.throws(() => inspection.confirm(buyer, o.id, {}), /분쟁 처리 중/);
  await assert.rejects(settlement.requestPayout(admin, o.id), /분쟁 처리 중입니다/);
  await settlement.tick({ force: true });
  assert.equal(q.get('SELECT COUNT(*) c FROM payouts').c, 0);
  // 외부 사업자도 지급을 막고 있다(내부 상태와 별개로 확인)
  await assert.rejects(sandbox.requestPayout({ idempotencyKey: 'x', providerPaymentId: q.get('SELECT provider_payment_id p FROM payments').p, amount: 1 }), /지급이 보류된 결제/);
  // 근거 없는 결정은 불가, 결정에는 처리자·일시가 남는다
  await assert.rejects(disputes.resolve(admin, d.id, { resolution: 'release', reason: '짧음' }), /판단 근거/);
  await disputes.resolve(admin, d.id, { resolution: 'release', reason: '구매자가 주장한 기능은 상품 설명의 제외 범위에 명시되어 있음' });
  const dd = disputes.getDispute(d.id);
  assert.equal(dd.resolved_by, admin.id); assert.ok(dd.resolved_at && dd.appeal_deadline);
  assert.equal(h.order(o.id).refund_status, 'rejected');
  await assert.rejects(settlement.requestPayout(admin, o.id), /이의제기 기간 중/);
  clock.advanceDays(8);
  await settlement.tick();
  assert.equal(h.order(o.id).payout_status, 'requested');
});

test('8-1. 외부 보류가 지원되지 않거나 실패하면 그대로 표시한다', async () => {
  sandbox.state.disputeHold = false;
  const o = await paidOrder();
  const d = await disputes.open(buyer, o.id, { reasonCode: 'other', description: '문제가 있어 확인을 요청합니다.' });
  assert.equal(d.external_hold, 'unsupported');
  assert.match(d.external_hold_detail, /플랫폼의 정산 요청만 보류/);
  h.reset(); admin = h.staff('super'); s = h.seller(admin); buyer = h.user('buyer'); prod = await h.sourceProduct(s, admin);
  sandbox.state.faults.holdFail = true;
  const o2 = await paidOrder();
  const d2 = await disputes.open(buyer, o2.id, { reasonCode: 'other', description: '문제가 있어 확인을 요청합니다.' });
  assert.equal(d2.external_hold, 'failed');
  assert.equal(h.order(o2.id).payout_status, 'held');
});

test('8-2. 이미 정산된 거래의 분쟁은 사후 회수 검토로 연결', async () => {
  const o = await confirmed();
  await settlement.requestPayout(admin, o.id); await settlement.tick();
  const d = await disputes.open(buyer, o.id, { reasonCode: 'rights_infringement', description: '타인의 소스를 복제한 것으로 보입니다.', requestedOutcome: 'refund_full' });
  assert.equal(d.post_payout, 1); assert.equal(d.external_hold, 'not_applicable');
  assert.equal(h.order(o.id).payout_status, 'clawback_review');
  const r = await disputes.resolve(admin, d.id, { resolution: 'refund_full', reason: '권리 침해 자료가 확인되어 환불이 타당함' });
  assert.equal(r.clawback, true);
  assert.equal(h.order(o.id).refund_status, 'manual_required', '자동 환불되지 않고 수동 검토로');
  assert.equal(h.order(o.id).payment_status, 'paid');
  assert.equal(q.get('SELECT refunded FROM sandbox_payments').refunded, 0);
});

test('9. 환불과 정산의 동시 실행', async () => {
  for (const first of ['payout', 'refund']) {
    h.reset(); admin = h.staff('super'); s = h.seller(admin); buyer = h.user('buyer'); prod = await h.sourceProduct(s, admin, { price: 500000 });
    const o = await confirmed();
    sandbox.state.faults.delayMs = 20;           // 외부 호출이 겹치도록
    const run = { payout: () => settlement.requestPayout(admin, o.id), refund: () => refunds.execute(admin, o.id, 500000, { reason: '동시 실행 시험' }) };
    const results = await Promise.allSettled(first === 'payout' ? [run.payout(), run.refund()] : [run.refund(), run.payout()]);
    sandbox.state.faults.delayMs = 0;
    await settlement.tick(); await refunds.tick();
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1, `${first} 먼저: 둘 중 하나만 진행`);
    const ext = q.get('SELECT * FROM sandbox_payments');
    const paidOut = q.get("SELECT COALESCE(SUM(amount),0) s FROM sandbox_payouts WHERE status = 'PAID'").s;
    assert.ok(ext.refunded + paidOut <= ext.amount, '같은 돈이 두 번 나가지 않는다');
    assert.ok(ext.refunded === 0 || paidOut === 0);
    assert.ok(ledger.sellerPayable(o.id) >= 0);
    assert.deepEqual((await reconcile.run()).issues, []);
  }
});

test('9-1. 같은 주문에 지급 요청을 동시에 두 번 해도 한 번만 지급', async () => {
  const o = await confirmed();
  sandbox.state.faults.delayMs = 10;
  const rs = await Promise.allSettled([settlement.requestPayout(admin, o.id), settlement.requestPayout(admin, o.id), settlement.tick({ force: true })]);
  sandbox.state.faults.delayMs = 0;
  await settlement.tick();
  assert.equal(q.get('SELECT COUNT(*) c FROM sandbox_payouts').c, 1);
  assert.equal(q.get("SELECT COUNT(*) c FROM payouts WHERE status = 'paid'").c, 1);
  assert.ok(rs.some((r) => r.status === 'rejected'));
});

test('10. 중복·지연·역순 웹훅', async () => {
  const o = orders.createProductOrder(buyer, { productId: prod.pid, optionId: prod.optId, agreed: true });
  const r = await orders.startPayment(o, buyer);
  sandbox.state.holdWebhooks = true;
  await sandbox.simulate(r.providerPaymentId);
  assert.equal(h.order(o.id).payment_status, 'pending', '웹훅이 오기 전에는 대기');
  const paidEv = sandbox.state.outbox.shift();
  // 위조·변조된 웹훅은 거절
  await assert.rejects(webhooks.handle('sandbox', paidEv.rawBody, { ...paidEv.headers, 'x-sandbox-signature': 'f'.repeat(64) }), /웹훅 검증 실패/);
  await assert.rejects(webhooks.handle('sandbox', paidEv.rawBody.replace('payment.paid', 'payment.xxxx'), paidEv.headers), /웹훅 검증 실패/);
  assert.equal(h.order(o.id).payment_status, 'pending');
  // 같은 이벤트가 세 번 와도 한 번만 반영
  assert.equal((await webhooks.handle('sandbox', paidEv.rawBody, paidEv.headers)).status, 'processed');
  assert.equal((await webhooks.handle('sandbox', paidEv.rawBody, paidEv.headers)).status, 'duplicate');
  assert.equal((await webhooks.handle('sandbox', paidEv.rawBody, paidEv.headers)).status, 'duplicate');
  assert.equal(q.get('SELECT COUNT(*) c FROM entitlements').c, 1);
  assert.equal(q.get("SELECT COUNT(*) c FROM ledger_entries WHERE event = 'payment' AND account = 'pg_holding'").c, 1);
  assert.equal(ledger.balance(o.id, 'pg_holding'), 500000);
  // 다른 ID로 재전송된(지연된) 결제 이벤트도 이중 반영되지 않는다
  const again = sandbox.buildEvent('payment.paid', r.providerPaymentId);
  await webhooks.handle('sandbox', again.rawBody, again.headers);
  assert.equal(ledger.balance(o.id, 'pg_holding'), 500000);
  // 본문 내용을 믿지 않는다: 결제되지 않은 건에 '결제됨' 이벤트가 와도 사업자 조회 결과로 판단
  const o2 = orders.createProductOrder(h.user('b2'), { productId: prod.pid, optionId: prod.optId, agreed: true });
  const r2 = await orders.startPayment(o2, q.get('SELECT * FROM users WHERE id = ?', o2.buyer_id));
  const fake = sandbox.buildEvent('payment.paid', r2.providerPaymentId);
  await webhooks.handle('sandbox', fake.rawBody, fake.headers);
  assert.equal(h.order(o2.id).payment_status, 'pending');
  // 역순: 취소 이벤트가 결제 이벤트보다 먼저 도착
  const o3 = orders.createProductOrder(h.user('b3'), { productId: prod.pid, optionId: prod.optId, agreed: true });
  const r3 = await orders.startPayment(o3, q.get('SELECT * FROM users WHERE id = ?', o3.buyer_id));
  await sandbox.simulate(r3.providerPaymentId);
  await sandbox.cancelPayment({ providerPaymentId: r3.providerPaymentId, amount: 500000, idempotencyKey: 'ext-cancel' });  // 사업자 쪽에서 직접 취소됨
  const [evPaid, evCancel] = sandbox.state.outbox.splice(0);
  await webhooks.handle('sandbox', evCancel.rawBody, evCancel.headers);
  await webhooks.handle('sandbox', evPaid.rawBody, evPaid.headers);
  const rec = await reconcile.run();
  assert.ok(rec.issues.some((i) => i.kind === 'refund_mismatch' && i.orderId === o3.id), '플랫폼이 모르는 외부 취소는 대사에서 불일치로 잡힌다');
});

test('10-1. 웹훅이 유실돼도 대사가 결제를 복구한다', async () => {
  const o = orders.createProductOrder(buyer, { productId: prod.pid, optionId: prod.optId, agreed: true });
  const r = await orders.startPayment(o, buyer);
  sandbox.state.holdWebhooks = true;
  await sandbox.simulate(r.providerPaymentId);
  sandbox.state.outbox.length = 0;                     // 유실
  const rec = await reconcile.run();
  assert.equal(rec.recovered, 1);
  assert.equal(h.order(o.id).payment_status, 'paid');
  assert.equal(h.order(o.id).delivery_status, 'delivered');
});

test('11. 외부 지급 요청 타임아웃', async () => {
  // (a) 사업자는 처리했는데 응답만 끊긴 경우 → 재요청 없이 조회로 확정
  const o = await confirmed();
  sandbox.state.faults.payoutTimeout = true;
  const po = await settlement.requestPayout(admin, o.id);
  assert.equal(po.status, 'unknown', '실패로 단정하지 않는다');
  assert.equal(h.order(o.id).payout_status, 'unknown');
  await assert.rejects(settlement.requestPayout(admin, o.id), /이미 지급되었거나 지급이 진행 중/);
  sandbox.state.faults = {};
  await settlement.tick();
  assert.equal(h.order(o.id).payout_status, 'paid');
  assert.equal(q.get('SELECT COUNT(*) c FROM sandbox_payouts').c, 1, '이중 지급 없음');
  // (b) 사업자에 도달하지 못한 경우 → 조회로 없음을 확인한 뒤 같은 멱등 키로 재시도
  h.reset(); admin = h.staff('super'); s = h.seller(admin); buyer = h.user('buyer'); prod = await h.sourceProduct(s, admin);
  const o2 = await confirmed();
  sandbox.state.faults.payoutTimeoutNotProcessed = true;
  const po2 = await settlement.requestPayout(admin, o2.id);
  assert.equal(po2.status, 'unknown');
  assert.equal(q.get('SELECT COUNT(*) c FROM sandbox_payouts').c, 0);
  sandbox.state.faults = {};
  await settlement.tick();          // 조회 → 없음 → 같은 키로 재요청
  await settlement.tick();          // 접수 → 완료 확인
  const row = q.get('SELECT * FROM payouts WHERE order_id = ?', o2.id);
  assert.equal(row.status, 'paid'); assert.equal(row.attempts, 2);
  assert.equal(q.get('SELECT idem FROM sandbox_payouts').idem, row.idempotency_key);
  assert.equal(q.get('SELECT COUNT(*) c FROM sandbox_payouts').c, 1);
  // (c) 명확한 거절 → 실패 처리 후 금액이 다시 지급 대기로
  h.reset(); admin = h.staff('super'); s = h.seller(admin); buyer = h.user('buyer'); prod = await h.sourceProduct(s, admin);
  const o3 = await confirmed();
  sandbox.state.faults.payoutFail = true;
  assert.equal((await settlement.requestPayout(admin, o3.id)).status, 'failed');
  assert.equal(ledger.sellerPayable(o3.id), 450000);
  sandbox.state.faults = {};
  await settlement.tick(); await settlement.tick();
  assert.equal(h.order(o3.id).payout_status, 'paid');
});

test('12. 부분 환불 미지원 결제수단 처리', async () => {
  const o = await paidOrder({ method: 'vbank' });
  const d = await disputes.open(buyer, o.id, { reasonCode: 'missing_files', description: '설치 문서 일부가 빠져 있습니다.', requestedOutcome: 'refund_partial' });
  const r = await disputes.resolve(admin, d.id, { resolution: 'refund_partial', amount: 100000, reason: '문서 누락분에 대해 일부 환불이 타당함' });
  assert.equal(r.status, 'manual_required');
  const after = h.order(o.id);
  assert.equal(after.refund_status, 'manual_required', '지원하지 않는 부분 취소를 완료로 표시하지 않는다');
  assert.equal(after.refunded_amount, 0);
  assert.equal(q.get('SELECT refunded FROM sandbox_payments').refunded, 0);
  await assert.rejects(settlement.requestPayout(admin, o.id), /환불 절차가 진행 중/);
  // 같은 조건에서 카드는 부분 환불이 실제로 처리된다
  h.reset(); admin = h.staff('super'); s = h.seller(admin); buyer = h.user('buyer'); prod = await h.sourceProduct(s, admin, { price: 500000 });
  const o2 = await paidOrder({ method: 'card' });
  const r2 = await refunds.execute(admin, o2.id, 100000, { reason: '부분 환불' });
  assert.equal(r2.status, 'completed');
  const a2 = h.order(o2.id);
  assert.equal(a2.payment_status, 'partially_refunded'); assert.equal(a2.refunded_amount, 100000);
  assert.equal(ledger.platformFee(o2.id), 40000, '남은 거래액 기준으로 수수료 재계산');
  assert.equal(ledger.sellerPayable(o2.id), 360000);
  assert.ok(access.issueForOrder(buyer, o2.id, firstFile(a2).id), '부분 환불은 접근 유지');
  assert.deepEqual((await reconcile.run()).issues, []);
});

test('12-1. 환불은 사업자 취소가 확인돼야 완료', async () => {
  const o = await paidOrder();
  sandbox.state.faults.cancelFail = true;
  const r = await refunds.execute(admin, o.id, 500000, { reason: '환불' });
  assert.equal(r.status, 'failed');
  assert.equal(h.order(o.id).payment_status, 'paid');
  assert.equal(h.order(o.id).refund_status, 'failed');
  assert.equal(ledger.sellerPayable(o.id), 450000, '예약한 금액이 되돌아온다');
  // 응답이 끊긴 경우: 처리 중으로 두고 조회로 확정
  sandbox.state.faults = { cancelTimeout: true };
  const r2 = await refunds.execute(admin, o.id, 500000, { reason: '환불 재시도' });
  assert.equal(r2.status, 'processing');
  assert.equal(h.order(o.id).refund_status, 'processing');
  sandbox.state.faults = {};
  await refunds.tick();
  assert.equal(h.order(o.id).refund_status, 'completed');
  assert.equal(h.order(o.id).payment_status, 'refunded');
  assert.equal(q.get('SELECT COUNT(*) c FROM sandbox_refunds').c, 1);
});

test('13. 검수 기한과 외부 자동확정 일정 충돌', async () => {
  // 사업자 최대 보류 5일 < 검수 7일 + 분쟁 여유 3일 → 결제 차단
  sandbox.state.maxHoldDays = 5;
  assert.throws(() => orders.createProductOrder(buyer, { productId: prod.pid, optionId: prod.optId, agreed: true }), (e) => e.code === 'SCHEDULE_CONFLICT' && /최대 보류 기간\(5일\)/.test(e.message));
  sandbox.state.maxHoldDays = 30;
  // 사업자가 8일 뒤 자동확정 → 검수 종료(10일)보다 먼저 지급될 수 있으므로 차단
  sandbox.state.autoConfirmDays = 8;
  assert.throws(() => orders.createProductOrder(buyer, { productId: prod.pid, optionId: prod.optId, agreed: true }), /자동확정/);
  sandbox.state.autoConfirmDays = 14;
  const o = orders.createProductOrder(buyer, { productId: prod.pid, optionId: prod.optId, agreed: true });
  // 주문 후 사업자 설정이 바뀌면 결제 시점에 다시 막는다
  sandbox.state.autoConfirmDays = 8;
  await assert.rejects(orders.startPayment(o, buyer), /자동확정/);
  const page = await http.client(buyer).get(`/products/${prod.pid}`);
  assert.match(page.text, /자동확정하므로/);
  assert.ok(!page.text.includes('주문하고 조건 확인</button>'), '구매 버튼이 표시되지 않는다');
});

test('13-1. 플랫폼 자동확정은 설정을 켠 경우에만, 아니면 판매자의 검수 종료 심사', async () => {
  const o = await paidOrder();
  assert.throws(() => inspection.requestCloseReview(s, o.id), /검수 기한이 지난 뒤/);
  clock.advanceDays(8);
  inspection.tick(); await settlement.tick();
  assert.equal(h.order(o.id).inspection_status, 'in_progress', '기본값: 자동확정하지 않는다');
  inspection.requestCloseReview(s, o.id);
  assert.throws(() => inspection.closeByAdmin(admin, o.id, ''), /처리 근거/);
  inspection.closeByAdmin(admin, o.id, '기한 경과 후 구매자 무응답, 다운로드 기록 확인');
  assert.equal(h.order(o.id).inspection_status, 'closed_by_admin');
  assert.equal(h.order(o.id).payout_status, 'eligible');
  h.reset(); admin = h.staff('super'); s = h.seller(admin); buyer = h.user('buyer'); prod = await h.sourceProduct(s, admin);
  q.run("UPDATE settings SET value = '1' WHERE key = 'auto_confirm_enabled'");
  const o2 = await paidOrder();
  clock.advanceDays(8); inspection.tick();
  assert.equal(h.order(o2.id).inspection_status, 'auto_approved');
});

test('14. 환불 뒤 이미 다운로드한 파일의 처리 한계 표시', async () => {
  const o = await paidOrder();
  const f = firstFile(o);
  access.consume(buyer, access.issueForOrder(buyer, o.id, f.id));        // 환불 전에 이미 받음
  const pending = access.issueForOrder(buyer, o.id, f.id);               // 환불 전에 발급만 받아 둔 링크
  const r = await refunds.execute(admin, o.id, 500000, { reason: '합의 환불' });
  assert.equal(r.status, 'completed');
  assert.equal(q.get('SELECT status FROM entitlements WHERE order_id = ?', o.id).status, 'revoked');
  assert.throws(() => access.issueForOrder(buyer, o.id, f.id), /환불 완료된 주문/);
  assert.throws(() => access.consume(buyer, pending), /환불 완료된 주문/, '미리 받아 둔 링크도 사용 시점에 차단');
  const c = http.client(buyer);
  const page = await c.get(`/my/orders/${o.id}`);
  assert.match(page.text, /원격으로 삭제하거나 회수할 수 없으므로/);
  assert.match(page.text, /받은 파일의 사용을 중단하고 보유한 사본을 삭제했습니다/);
  assert.ok(!/원격 삭제(를|가) (완료|보장)/.test(page.text));
  await c.post(`/my/orders/${o.id}/ack-termination`, { ack: '1' });
  assert.ok(h.order(o.id).use_termination_ack_at);
  assert.match((await http.client().get('/guide')).text, /원격으로 삭제하거나 회수할 수 없습니다/);
  assert.equal(h.order(o.id).payout_status, 'not_eligible');
  assert.equal(ledger.sellerPayable(o.id), 0);
});

test('수수료: 주문 시점 정책 고정, 판매자별·카테고리별·할인 기간 우선순위', async () => {
  const o = await paidOrder();
  assert.equal(o.fee_bps, 1000);
  q.insert('fee_policies', { scope: 'default', rate_bps: 2000, label: '인상', created_at: clock.iso() });
  assert.equal(h.order(o.id).fee_bps, 1000, '기존 주문은 영향 없음');
  assert.throws(() => q.run('UPDATE orders SET fee_bps = 2000 WHERE id = ?', o.id), /ORDER_TERMS_FROZEN/);
  const fees = require('../src/services/fees');
  assert.equal(fees.quote(100000, s.id, null).fee_amount, 20000);
  q.insert('fee_policies', { scope: 'category', scope_id: 1, rate_bps: 800, created_at: clock.iso() });
  q.insert('fee_policies', { scope: 'seller', scope_id: s.id, rate_bps: 500, created_at: clock.iso() });
  assert.equal(fees.quote(100000, 9999, 1).fee_bps, 800);
  assert.equal(fees.quote(100000, s.id, 1).fee_bps, 500);
  q.insert('fee_policies', { scope: 'seller', scope_id: s.id, rate_bps: 0, label: '입점 할인', starts_at: clock.iso(), ends_at: new Date(clock.now().getTime() + 86400000).toISOString(), created_at: clock.iso() });
  assert.equal(fees.quote(100000, s.id, 1).fee_bps, 0);
  clock.advanceDays(2);
  assert.equal(fees.quote(100000, s.id, 1).fee_bps, 500, '할인 기간이 끝나면 원래 정책');
  assert.equal(fees.quote(333333, 9999, null).fee_amount, 66666, '원 단위 절사');
  q.run("UPDATE settings SET value = 'seller' WHERE key = 'pg_fee_bearer'");
  assert.equal(fees.quote(100000, 9999, null).seller_net, 100000 - 20000 - 3300);
});

test('정산 계좌 변경: 재인증 필요, 알림, 변경 직후 지급 보류', async () => {
  const o = await confirmed();
  const stale = h.refresh(s); stale.session.reauthAt = new Date(clock.now() - 3600000).toISOString();
  assert.throws(() => accounts.setBankAccount(stale, { bank: '신한', account: '999988887777', holder: '공격자' }), (e) => e.code === 'REAUTH_REQUIRED');
  accounts.setBankAccount(h.refresh(s), { bank: '신한', account: '110123456789', holder: 'seller' });
  assert.ok(q.get("SELECT 1 FROM notifications WHERE user_id = ? AND title = '정산 계좌가 변경되었습니다'", s.id));
  assert.ok(!q.get('SELECT account_enc e FROM seller_bank_accounts ORDER BY id DESC').e.includes('110123456789'), '계좌번호는 암호화 저장');
  await assert.rejects(settlement.requestPayout(admin, o.id), /계좌 변경 후 보류 기간/);
  clock.advanceDays(4);
  assert.equal((await settlement.requestPayout(admin, o.id)).status, 'requested');
});

test('후기는 검수를 마친 실제 구매자만', async () => {
  const o = await paidOrder();
  const c = http.client(buyer);
  let r = await c.post(`/my/orders/${o.id}/review`, { rating: '5', body: '아직 검수 전인데 후기를 써 봅니다' });
  assert.equal(q.get('SELECT COUNT(*) c FROM reviews').c, 0);
  inspection.confirm(buyer, o.id, {});
  r = await http.client(h.user('stranger')).post(`/my/orders/${o.id}/review`, { rating: '1', body: '구매하지 않은 사람의 허위 후기입니다' });
  assert.equal(q.get('SELECT COUNT(*) c FROM reviews').c, 0);
  await c.post(`/my/orders/${o.id}/review`, { rating: '5', body: '설치 문서대로 잘 실행되었습니다' });
  await c.post(`/my/orders/${o.id}/review`, { rating: '5', body: '같은 주문에 두 번째 후기 시도입니다' });
  assert.equal(q.get('SELECT COUNT(*) c FROM reviews').c, 1);
});

test('원장·감사 기록은 수정·삭제할 수 없다', async () => {
  const o = await paidOrder();
  assert.throws(() => q.run('UPDATE ledger_entries SET amount = 1 WHERE order_id = ?', o.id), /LEDGER_APPEND_ONLY/);
  assert.throws(() => q.run('DELETE FROM ledger_entries'), /LEDGER_APPEND_ONLY/);
  assert.throws(() => q.run('DELETE FROM audit_logs'), /AUDIT_APPEND_ONLY/);
  assert.equal(q.get('SELECT COUNT(*) c FROM (SELECT txn FROM ledger_entries GROUP BY txn HAVING SUM(amount) <> 0)').c, 0);
});
