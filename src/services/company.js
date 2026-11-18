'use strict';
// 기업 계정: 관리자(admin) · 구매 담당자(buyer) · 검수 담당자(inspector)
const { q } = require('../db');
const { clock, must, forbidden, notFound, str, int } = require('../util');
const { audit, notify } = require('../log');

const ROLES = { admin: '관리자', buyer: '구매 담당자', inspector: '검수 담당자' };
const member = (companyId, userId) => q.get('SELECT * FROM company_members WHERE company_id = ? AND user_id = ?', companyId, userId);
function load(user, companyId, needAdmin = false) {
  const c = q.get('SELECT * FROM companies WHERE id = ?', companyId);
  const m = c && member(c.id, user.id);
  if (!m) throw notFound();              // 구성원이 아니면 존재 여부도 알리지 않는다.
  if (needAdmin && m.role !== 'admin') throw forbidden('기업 관리자만 할 수 있습니다.');
  return { company: c, me: m };
}
const adminCount = (companyId) => q.get("SELECT COUNT(*) c FROM company_members WHERE company_id = ? AND role = 'admin'", companyId).c;

function create(user, { name, bizNo }) {
  must(str(name, 80).length >= 2, '기업 이름을 입력하세요.');
  let id;
  q.tx(() => {
    id = q.insert('companies', { name: str(name, 80), biz_no: str(bizNo, 20), created_by: user.id, created_at: clock.iso() });
    q.insert('company_members', { company_id: id, user_id: user.id, role: 'admin', created_at: clock.iso() });
  });
  audit(user, 'company.create', 'company', id);
  return id;
}
function addMember(user, companyId, { email, role }) {
  const { company } = load(user, companyId, true);
  must(ROLES[role], '권한을 선택하세요.');
  const u = q.get("SELECT id FROM users WHERE email = ? AND status = 'active'", str(email, 200));
  must(u, '해당 이메일로 가입한 회원이 없습니다. 먼저 회원가입이 필요합니다.', 404);
  must(!member(company.id, u.id), '이미 구성원입니다.', 409);
  q.insert('company_members', { company_id: company.id, user_id: u.id, role, created_at: clock.iso() });
  audit(user, 'company.member.add', 'company', company.id, { user_id: u.id, role });
  notify(u.id, `기업 계정에 추가되었습니다: ${company.name}`, ROLES[role], '/my/company');
}
function setRole(user, companyId, userId, role) {
  const { company } = load(user, companyId, true);
  must(ROLES[role], '권한을 선택하세요.');
  const m = member(company.id, userId);
  must(m, '구성원이 아닙니다.', 404);
  must(!(m.role === 'admin' && role !== 'admin' && adminCount(company.id) <= 1), '관리자가 한 명뿐이라 권한을 바꿀 수 없습니다.', 409);
  q.run('UPDATE company_members SET role = ? WHERE company_id = ? AND user_id = ?', role, company.id, userId);
  audit(user, 'company.member.role', 'company', company.id, { user_id: userId, role });
}
function removeMember(user, companyId, userId) {
  const { company } = load(user, companyId, true);
  const m = member(company.id, userId);
  must(m, '구성원이 아닙니다.', 404);
  must(!(m.role === 'admin' && adminCount(company.id) <= 1), '마지막 관리자는 제거할 수 없습니다.', 409);
  q.run('DELETE FROM company_members WHERE company_id = ? AND user_id = ?', company.id, userId);
  audit(user, 'company.member.remove', 'company', company.id, { user_id: userId });
}
function setRequireApproval(user, companyId, on) {
  const { company } = load(user, companyId, true);
  q.update('companies', company.id, { require_approval: on ? 1 : 0 });
  audit(user, 'company.require_approval', 'company', company.id, { on: !!on });
}

// 구매 승인 요청(구매 담당자) → 관리자 승인 → 주문 생성 시 1회 사용
function requestApproval(user, { companyId, productId, optionId, note }) {
  const { company, me } = load(user, int(companyId));
  must(me.role !== 'inspector', '검수 담당자는 구매를 요청할 수 없습니다.', 403);
  const opt = q.get(`SELECT o.id, o.name, o.price, p.title FROM product_options o JOIN products p ON p.id = o.product_id
    WHERE o.id = ? AND o.product_id = ? AND o.active = 1 AND p.status = 'approved'`, int(optionId), int(productId));
  must(opt, '판매 중인 상품과 옵션을 선택하세요.', 404);
  must(!q.get("SELECT 1 FROM purchase_approvals WHERE company_id = ? AND requester_id = ? AND product_id = ? AND option_id = ? AND status IN ('pending','approved')", company.id, user.id, int(productId), opt.id), '이미 요청했거나 승인된 건이 있습니다.', 409);
  const id = q.insert('purchase_approvals', { company_id: company.id, requester_id: user.id, product_id: int(productId), option_id: opt.id, note: str(note, 1000), created_at: clock.iso() });
  for (const a of q.all("SELECT user_id FROM company_members WHERE company_id = ? AND role = 'admin'", company.id)) notify(a.user_id, '구매 승인 요청', `${opt.title} — ${opt.name} · ${opt.price.toLocaleString('ko-KR')}원`, '/my/company');
  audit(user, 'company.approval.request', 'purchase_approval', id);
  return id;
}
function decideApproval(user, approvalId, approve) {
  const a = q.get('SELECT * FROM purchase_approvals WHERE id = ?', approvalId);
  if (!a) throw notFound();
  load(user, a.company_id, true);
  must(a.status === 'pending', '이미 처리된 요청입니다.', 409);
  q.update('purchase_approvals', a.id, { status: approve ? 'approved' : 'rejected', decided_by: user.id, decided_at: clock.iso() });
  audit(user, 'company.approval.decide', 'purchase_approval', a.id, { approve: !!approve });
  notify(a.requester_id, `구매 승인 요청이 ${approve ? '승인' : '반려'}되었습니다`, approve ? '상품 화면에서 기업 계정으로 주문할 수 있습니다.' : '', approve ? `/products/${a.product_id}` : '/my/company');
}

const mine = (user) => q.all('SELECT c.*, m.role FROM companies c JOIN company_members m ON m.company_id = c.id WHERE m.user_id = ? ORDER BY c.id', user.id);
const members = (companyId) => q.all('SELECT m.*, u.name, u.email FROM company_members m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? ORDER BY m.created_at', companyId);
const approvals = (companyId) => q.all(`SELECT a.*, u.name AS requester, p.title, o.name AS option_name, o.price FROM purchase_approvals a
  JOIN users u ON u.id = a.requester_id JOIN products p ON p.id = a.product_id JOIN product_options o ON o.id = a.option_id
  WHERE a.company_id = ? ORDER BY a.id DESC LIMIT 100`, companyId);
const companyOrders = (companyId) => q.all('SELECT o.*, u.name AS buyer_name FROM orders o JOIN users u ON u.id = o.buyer_id WHERE o.company_id = ? ORDER BY o.id DESC LIMIT 100', companyId);

module.exports = { ROLES, load, create, addMember, setRole, removeMember, setRequireApproval, requestApproval, decideApproval, mine, members, approvals, companyOrders };
