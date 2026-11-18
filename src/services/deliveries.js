'use strict';
// 판매자 납품(맞춤 개발 단계·지식재산권 자산·재납품)
const { q } = require('../db');
const { clock, must, forbidden } = require('../util');
const orders = require('./orders');
const scanner = require('../scanner');
const { audit, notify } = require('../log');

const MEDIA_ONLY = /\.(png|jpe?g|gif|webp|bmp|mp4|mov|avi|mkv|webm|pdf|pptx?)$/i;
const ROLES = { executable: '실행 파일', source: '소스코드', install_doc: '설치 설명서', dependencies: '의존성 목록', env_example: '환경변수 예시', db_schema: 'DB 스키마·마이그레이션', license_notice: '라이선스·오픈소스 고지', guide: '이용 안내', other: '기타' };

function requirements(order) {
  const t = orders.snapshotOf(order).terms;
  return { requiresSource: !!t.requires_source, requiredRoles: t.required_roles || (t.requires_source ? ['source', 'install_doc'] : []) };
}

function draft(user, orderId) {
  const o = orders.getOrder(orderId);
  if (!o || o.seller_id !== user.id) throw forbidden();
  must(['paid', 'partially_refunded'].includes(o.payment_status), '결제가 확인된 뒤에 납품할 수 있습니다.', 409);
  must(['awaiting_seller', 'redelivery_requested'].includes(o.delivery_status), '지금은 납품을 등록할 수 없는 상태입니다.', 409);
  must(o.refund_status !== 'completed', '환불된 주문입니다.', 409);
  let d = q.get("SELECT * FROM deliveries WHERE order_id = ? AND status = 'draft'", o.id);
  if (!d) {
    const seq = (q.get('SELECT MAX(seq) m FROM deliveries WHERE order_id = ?', o.id).m || 0) + 1;
    d = q.get('SELECT * FROM deliveries WHERE id = ?', q.insert('deliveries', { order_id: o.id, seq, submitted_by: user.id, created_at: clock.iso() }));
  }
  return d;
}
function addFile(user, orderId, file, role) {
  must(ROLES[role], '파일 종류를 선택하세요.');
  const d = draft(user, orderId);
  q.insert('delivery_files', { delivery_id: d.id, file_id: file.id, role });
  return d;
}
function removeFile(user, orderId, fileId) {
  const d = draft(user, orderId);
  q.run('DELETE FROM delivery_files WHERE delivery_id = ? AND file_id = ?', d.id, fileId);
}
const filesOf = (deliveryId) => q.all('SELECT f.*, df.role FROM delivery_files df JOIN files f ON f.id = df.file_id WHERE df.delivery_id = ?', deliveryId);

// 누락·부적합 확인. 문제가 있으면 제출되지 않는다.
function check(order, d, files) {
  const req = requirements(order);
  const problems = [];
  if (!files.length) problems.push('납품 파일이 없습니다.');
  for (const r of req.requiredRoles) if (!files.some((f) => f.role === r)) problems.push(`필수 파일 누락: ${ROLES[r] || r}`);
  if (req.requiresSource) {
    const src = files.filter((f) => f.role === 'source');
    if (src.length && src.every((f) => MEDIA_ONLY.test(f.original_name))) problems.push('화면 캡처·영상·문서만으로는 소스 납품을 완료할 수 없습니다. 소스 묶음을 올려 주세요.');
    if (!d.run_instructions.trim() && !files.some((f) => f.role === 'install_doc')) problems.push('실행 방법(설치 설명서 또는 실행 안내)이 필요합니다.');
  }
  for (const f of files) if (scanner.overall(f) === 'flagged' && !f.scan_override_by) problems.push(`검사에서 문제가 발견된 파일: ${f.original_name}`);
  return problems;
}

function submit(user, orderId, { note, runInstructions }) {
  const d = draft(user, orderId);
  const o = orders.getOrder(orderId);
  q.update('deliveries', d.id, { note: String(note || '').slice(0, 5000), run_instructions: String(runInstructions || '').slice(0, 5000) });
  const cur = q.get('SELECT * FROM deliveries WHERE id = ?', d.id);
  const problems = check(o, cur, filesOf(d.id));
  q.update('deliveries', d.id, { missing_json: JSON.stringify(problems) });
  must(problems.length === 0, '납품을 제출할 수 없습니다: ' + problems.join(' / '), 422, 'DELIVERY_INCOMPLETE');
  const now = clock.iso();
  q.tx(() => {
    q.update('deliveries', d.id, { status: 'submitted', submitted_at: now });
    q.update('orders', o.id, { delivery_status: 'delivered', delivered_at: now });
    if (o.kind === 'milestone') q.run("UPDATE milestones SET status = 'delivered' WHERE id = ?", o.milestone_id);
    q.run("UPDATE revision_requests SET status = 'done' WHERE order_id = ? AND status = 'accepted'", o.id);
  });
  orders.startInspection(o.id);
  audit(user, 'delivery.submit', 'order', o.id, { delivery_id: d.id, late: o.delivery_due_at && now > o.delivery_due_at });
  notify(o.buyer_id, '납품물이 등록되었습니다', o.title, `/my/orders/${o.id}`);
  return q.get('SELECT * FROM deliveries WHERE id = ?', d.id);
}
module.exports = { ROLES, draft, addFile, removeFile, filesOf, check, submit, requirements };
