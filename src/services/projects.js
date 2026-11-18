'use strict';
// 맞춤 개발: 의뢰 → 제안 → 계약 버전(양측 동의) → 단계별 별도 주문·결제 → 납품 → 검수 → 정산
// 단계별 결제는 "임의 분할 지급"이 아니라 단계마다 별도의 주문·결제다.
const { q } = require('../db');
const { clock, sha256, stableStringify, must, forbidden, notFound, str, int, toWon, AppError } = require('../util');
const providers = require('../providers');
const orders = require('./orders');
const { audit, notify } = require('../log');

const KINDS = { new: '신규 개발', customize: '기존 상품 커스터마이징', install: '설치·배포', integration: '외부 시스템 연동', maintenance: '유지보수' };
const MS_STATUS = { pending: '이전 단계 대기', awaiting_payment: '결제 대기', in_progress: '작업 중', delivered: '납품 — 검수 중', revision: '수정 중', approved: '검수 승인', cancelled: '취소' };
const UNPAID = ['pending', 'awaiting_payment'];
const STAGED_UNSUPPORTED_MSG = '결제 사업자가 단계별 결제를 지원하는지 확인되지 않았습니다. 대체 절차: 단계 결제 대신 계약 전체를 한 번에 결제하는 단일 단계 계약으로 변경 계약을 맺거나, 고객지원에 문의해 주세요.';

const getRequest = (id) => q.get('SELECT * FROM requests WHERE id = ?', id);
const getContract = (id) => q.get('SELECT * FROM contracts WHERE id = ?', id);
const getVersion = (id) => q.get('SELECT * FROM contract_versions WHERE id = ?', id);
const milestonesOf = (contractId) => q.all('SELECT * FROM milestones WHERE contract_id = ? ORDER BY seq', contractId);
const termsOf = (v) => JSON.parse(v.terms_json);

// ── 의뢰
function createRequest(user, body) {
  const row = {
    buyer_id: user.id,
    kind: KINDS[body.kind] ? body.kind : 'new',
    related_product_id: null,
    title: str(body.title, 120), purpose: str(body.purpose), requirements: str(body.requirements, 8000),
    environment: str(body.environment, 2000),
    budget_min: body.budget_min ? toWon(body.budget_min) : null, budget_max: body.budget_max ? toWon(body.budget_max) : null,
    due_date: /^\d{4}-\d{2}-\d{2}$/.test(String(body.due_date || '')) ? body.due_date : null,
    reference_notes: str(body.reference_notes), source_terms: str(body.source_terms, 2000), rights_terms: str(body.rights_terms, 2000),
    maintenance_terms: str(body.maintenance_terms, 2000),
    visibility: body.visibility === 'private' ? 'private' : 'public', invited_seller_id: null,
    created_at: clock.iso(),
  };
  must(row.title.length >= 2, '의뢰 제목을 입력하세요.');
  must(row.requirements.length >= 10, '기능 요구사항을 10자 이상 적어 주세요.');
  if (row.budget_min != null && row.budget_max != null) must(row.budget_min <= row.budget_max, '예산 범위가 올바르지 않습니다.');
  if (int(body.related_product_id)) {
    const p = q.get("SELECT id, seller_id FROM products WHERE id = ? AND status IN ('approved','pending_review')", int(body.related_product_id));
    must(p, '관련 상품을 찾을 수 없습니다.', 404);
    row.related_product_id = p.id;
    // 상품별 추가 개발 요청: 해당 판매자를 초대한다.
    if (!int(body.invited_seller_id)) row.invited_seller_id = p.seller_id;
  }
  if (int(body.invited_seller_id)) {
    const s = q.get("SELECT user_id FROM seller_profiles WHERE user_id = ? AND status = 'approved'", int(body.invited_seller_id));
    must(s, '초대할 판매자를 찾을 수 없습니다.', 404);
    row.invited_seller_id = s.user_id;
  }
  must(row.invited_seller_id !== user.id, '본인에게 의뢰할 수 없습니다.');
  must(row.visibility === 'public' || row.invited_seller_id, '비공개 의뢰는 초대할 판매자를 지정해야 합니다.');
  const id = q.insert('requests', row);
  if (row.invited_seller_id) notify(row.invited_seller_id, '개발 의뢰 초대가 도착했습니다', row.title, `/requests/${id}`);
  audit(user, 'request.create', 'request', id, { visibility: row.visibility });
  return getRequest(id);
}

// 비공개 의뢰는 의뢰자, 초대된 판매자(및 운영자)만 볼 수 있다.
function canView(user, r) {
  if (r.visibility === 'public') return true;
  return !!user && (user.id === r.buyer_id || user.id === r.invited_seller_id || (user.staff || []).length > 0);
}
function loadRequest(user, id) {
  const r = getRequest(id);
  if (!r || !canView(user, r)) throw notFound('의뢰를 찾을 수 없습니다.');
  return r;
}
function listPublic({ q: kw, kind } = {}) {
  const where = ["r.visibility = 'public'", "r.status = 'open'"], args = [];
  if (kw) { where.push('(r.title LIKE ? OR r.requirements LIKE ?)'); const k = `%${str(kw, 60)}%`; args.push(k, k); }
  if (KINDS[kind]) { where.push('r.kind = ?'); args.push(kind); }
  return q.all(`SELECT r.*, (SELECT COUNT(*) FROM proposals p WHERE p.request_id = r.id AND p.status = 'submitted') AS proposal_count
    FROM requests r WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT 100`, ...args);
}
function cancelRequest(user, id) {
  const r = getRequest(id);
  if (!r || r.buyer_id !== user.id) throw forbidden();
  must(r.status === 'open', '진행 중인 계약이 있거나 이미 마감된 의뢰입니다.', 409);
  q.update('requests', r.id, { status: 'cancelled' });
}

// ── 제안(견적)
// 폼에서 온 단계 배열을 정리한다. 제목이 빈 줄은 건너뛴다.
function parseMilestones(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || !str(m.title, 120)) continue;
    const amount = toWon(m.amount);
    must(amount >= 1000, '단계 금액은 1,000원 이상이어야 합니다.');
    const days = int(m.days, 14);
    must(days >= 1 && days <= 365, '단계 기간은 1~365일로 입력하세요.');
    out.push({ title: str(m.title, 120), deliverables: str(m.deliverables, 2000), amount, days, criteria: str(m.criteria, 2000), requires_source: m.requires_source && m.requires_source !== '0' ? 1 : 0 });
  }
  return out;
}
// 같은 이름의 배열 필드(m_title[] 등)를 단계 객체 배열로 바꾼다.
function milestonesFromForm(body, prefix = 'm_') {
  const arr = (k) => { const v = body[prefix + k]; return Array.isArray(v) ? v : v == null ? [] : [v]; };
  const titles = arr('title');
  return titles.map((t, i) => ({ title: t, deliverables: arr('deliverables')[i], amount: arr('amount')[i], days: arr('days')[i], criteria: arr('criteria')[i], requires_source: arr('requires_source')[i] }))
    .filter((m) => str(m.title));
}

function propose(seller, requestId, body) {
  must(seller.seller && seller.seller.status === 'approved', '판매자 심사가 승인된 뒤 제안할 수 있습니다.', 403);
  const r = loadRequest(seller, requestId);
  must(r.status === 'open', '제안을 받지 않는 의뢰입니다.', 409);
  must(r.buyer_id !== seller.id, '본인의 의뢰에는 제안할 수 없습니다.');
  const ms = parseMilestones(body.milestones);
  must(ms.length >= 1, '단계를 1개 이상 입력하세요.');
  must(str(body.scope).length >= 10, '작업 범위를 10자 이상 적어 주세요.');
  const total = ms.reduce((s, m) => s + m.amount, 0);
  const row = { scope: str(body.scope, 8000), exclusions: str(body.exclusions, 4000), revision_scope: str(body.revision_scope, 2000), support_terms: str(body.support_terms, 2000), milestones_json: JSON.stringify(ms), total };
  const ex = q.get('SELECT * FROM proposals WHERE request_id = ? AND seller_id = ?', r.id, seller.id);
  let id;
  if (ex) {
    must(['submitted', 'withdrawn'].includes(ex.status), '이미 처리된 제안입니다.', 409);
    q.update('proposals', ex.id, { ...row, status: 'submitted' }); id = ex.id;
  } else id = q.insert('proposals', { request_id: r.id, seller_id: seller.id, ...row, created_at: clock.iso() });
  notify(r.buyer_id, '새 견적 제안이 도착했습니다', r.title, `/requests/${r.id}`);
  audit(seller, 'proposal.submit', 'proposal', id, { total });
  return q.get('SELECT * FROM proposals WHERE id = ?', id);
}
function withdrawProposal(seller, proposalId) {
  const p = q.get('SELECT * FROM proposals WHERE id = ?', proposalId);
  if (!p || p.seller_id !== seller.id) throw forbidden();
  must(p.status === 'submitted', '철회할 수 없는 제안입니다.', 409);
  q.update('proposals', p.id, { status: 'withdrawn' });
}

// 견적 비교용: 의뢰자에게만 보여 준다.
function compareProposals(requestId) {
  return q.all(`SELECT p.*, sp.display_name AS seller_name FROM proposals p JOIN seller_profiles sp ON sp.user_id = p.seller_id
    WHERE p.request_id = ? AND p.status IN ('submitted','accepted') ORDER BY p.total, p.id`, requestId).map((p) => {
    const ms = JSON.parse(p.milestones_json);
    return { ...p, milestones: ms, milestone_count: ms.length, total_days: ms.reduce((s, m) => s + m.days, 0), source_stage: ms.some((m) => m.requires_source) };
  });
}

// ── 계약
function insertVersion(contractId, versionNo, kind, terms, proposer, { changeSummary = '', buyerAgreed = false, sellerAgreed = false } = {}) {
  const json = stableStringify(terms);
  const now = clock.iso();
  return q.insert('contract_versions', {
    contract_id: contractId, version_no: versionNo, kind, terms_json: json, terms_hash: sha256(json), change_summary: str(changeSummary, 4000),
    proposed_by: proposer.id, buyer_agreed_at: buyerAgreed ? now : null, seller_agreed_at: sellerAgreed ? now : null, created_at: now,
  });
}

// 구매자가 제안을 선택 → 계약 초안(버전 1). 판매자의 제안이므로 판매자 동의는 기록된 상태로 시작한다.
function acceptProposal(buyer, proposalId) {
  const p = q.get('SELECT * FROM proposals WHERE id = ?', proposalId);
  const r = p && getRequest(p.request_id);
  if (!r || r.buyer_id !== buyer.id) throw notFound('제안을 찾을 수 없습니다.');
  must(r.status === 'open' && p.status === 'submitted', '선택할 수 없는 제안입니다.', 409);
  const ms = JSON.parse(p.milestones_json).map((m, i) => ({ seq: i + 1, ...m }));
  const terms = {
    title: r.title, scope: p.scope, exclusions: p.exclusions, revision_scope: p.revision_scope, support_terms: p.support_terms,
    source_terms: r.source_terms, rights_terms: r.rights_terms, maintenance_terms: r.maintenance_terms, environment: r.environment,
    inspection_days: 7, milestones: ms, total: p.total,
  };
  let cid;
  q.tx(() => {
    cid = q.insert('contracts', { request_id: r.id, proposal_id: p.id, buyer_id: r.buyer_id, seller_id: p.seller_id, title: r.title, created_at: clock.iso() });
    insertVersion(cid, 1, 'initial', terms, { id: p.seller_id }, { sellerAgreed: true });
    q.update('proposals', p.id, { status: 'accepted' });
    q.run("UPDATE proposals SET status = 'declined' WHERE request_id = ? AND id <> ? AND status = 'submitted'", r.id, p.id);
    q.update('requests', r.id, { status: 'contracting' });
  });
  audit(buyer, 'proposal.accept', 'contract', cid, { proposal_id: p.id });
  notify(p.seller_id, '제안이 선택되었습니다', `${r.title} — 구매자가 계약 조건에 동의하면 계약이 시작됩니다.`, `/my/contracts/${cid}`);
  return getContract(cid);
}

function loadContract(user, id) {
  const c = getContract(id);
  const role = c && (c.buyer_id === user.id ? 'buyer' : c.seller_id === user.id ? 'seller' : null);
  if (!role) throw notFound('계약을 찾을 수 없습니다.');
  return { contract: c, role };
}
const versionsOf = (contractId) => q.all('SELECT * FROM contract_versions WHERE contract_id = ? ORDER BY version_no DESC', contractId);

// 다음에 결제할 단계를 연다(진행 중인 단계가 없을 때 가장 앞선 대기 단계).
function openNextMilestone(contractId) {
  const ms = milestonesOf(contractId);
  if (ms.some((m) => ['awaiting_payment', 'in_progress', 'delivered', 'revision'].includes(m.status))) return null;
  const next = ms.find((m) => m.status === 'pending');
  if (next) q.update('milestones', next.id, { status: 'awaiting_payment' });
  return next || null;
}

function applyVersion(v, c) {
  const terms = termsOf(v);
  if (v.kind === 'initial') {
    for (const m of terms.milestones) q.insert('milestones', { contract_id: c.id, seq: m.seq, title: m.title, deliverables: m.deliverables, criteria: m.criteria, amount: m.amount, days: m.days, requires_source: m.requires_source ? 1 : 0, added_in_version: 1 });
    q.update('contracts', c.id, { status: 'active', current_version_id: v.id });
  } else {
    must(c.status === 'active', '진행 중인 계약만 변경할 수 있습니다.', 409);
    const existing = Object.fromEntries(milestonesOf(c.id).map((m) => [m.seq, m]));
    for (const m of terms.milestones) {
      const cur = existing[m.seq];
      if (!cur) { q.insert('milestones', { contract_id: c.id, seq: m.seq, title: m.title, deliverables: m.deliverables, criteria: m.criteria, amount: m.amount, days: m.days, requires_source: m.requires_source ? 1 : 0, added_in_version: v.version_no }); continue; }
      if (cur.amount === m.amount && cur.days === m.days) continue;
      // 이미 결제된(또는 결제가 진행 중인) 단계는 바꿀 수 없다.
      must(UNPAID.includes(cur.status), `${cur.seq}단계는 이미 결제되어 변경할 수 없습니다.`, 409);
      const patch = { amount: m.amount, days: m.days };
      if (cur.order_id) {
        const o = orders.getOrder(cur.order_id);
        must(['none', 'failed', 'cancelled'].includes(o.payment_status), `${cur.seq}단계는 결제가 진행 중이어서 변경할 수 없습니다.`, 409);
        patch.order_id = null;   // 금액이 고정된 미결제 주문은 버리고 새 조건으로 다시 만든다.
      }
      q.update('milestones', cur.id, patch);
    }
    q.run("UPDATE contract_versions SET status = 'superseded' WHERE contract_id = ? AND status = 'agreed'", c.id);
    q.update('contracts', c.id, { current_version_id: v.id });
  }
  q.update('contract_versions', v.id, { status: 'agreed' });
  openNextMilestone(c.id);
}

// 계약 버전 동의. 양측이 모두 동의해야 적용된다.
function agreeVersion(user, versionId) {
  const v = getVersion(versionId);
  const { contract: c, role } = loadContract(user, v ? v.contract_id : 0);
  must(v.status === 'proposed', '동의할 수 있는 상태가 아닙니다.', 409);
  let applied = false;
  q.txi(() => {
    const cur = getVersion(v.id);
    must(cur.status === 'proposed', '동의할 수 있는 상태가 아닙니다.', 409);
    const col = role === 'buyer' ? 'buyer_agreed_at' : 'seller_agreed_at';
    if (!cur[col]) q.update('contract_versions', cur.id, { [col]: clock.iso() });
    const after = getVersion(v.id);
    if (after.buyer_agreed_at && after.seller_agreed_at) { applyVersion(after, getContract(c.id)); applied = true; }
  });
  audit(user, 'contract.agree', 'contract_version', v.id, { contract_id: c.id, version_no: v.version_no, applied });
  const other = role === 'buyer' ? c.seller_id : c.buyer_id;
  if (applied) notify(other, v.kind === 'initial' ? '계약이 체결되었습니다' : '변경 계약이 적용되었습니다', `${c.title} — 계약 버전 ${v.version_no}`, `/my/contracts/${c.id}`);
  return getVersion(v.id);
}

function rejectVersion(user, versionId) {
  const v = getVersion(versionId);
  const { contract: c, role } = loadContract(user, v ? v.contract_id : 0);
  must(v.status === 'proposed', '거절할 수 있는 상태가 아닙니다.', 409);
  q.tx(() => {
    q.update('contract_versions', v.id, { status: 'rejected' });
    if (v.kind === 'initial') {
      // 첫 계약이 성립하지 않으면 의뢰를 다시 연다.
      q.update('contracts', c.id, { status: 'cancelled' });
      if (c.request_id) q.run("UPDATE requests SET status = 'open' WHERE id = ? AND status = 'contracting'", c.request_id);
      if (c.proposal_id) q.run("UPDATE proposals SET status = 'declined' WHERE id = ?", c.proposal_id);
    }
  });
  audit(user, 'contract.reject', 'contract_version', v.id, { contract_id: c.id });
  notify(role === 'buyer' ? c.seller_id : c.buyer_id, v.kind === 'initial' ? '계약 조건이 거절되었습니다' : '변경 계약 제안이 거절되었습니다', c.title, `/my/contracts/${c.id}`);
}

// 변경 계약 제안: 추가 단계, 그리고 아직 결제 전인 단계의 금액·기간 변경.
// 양측이 동의하기 전에는 아무것도 바뀌지 않는다.
function proposeChange(user, contractId, { change_summary: summary, changes = [], additions = [] }) {
  const { contract: c, role } = loadContract(user, contractId);
  must(c.status === 'active', '진행 중인 계약만 변경할 수 있습니다.', 409);
  must(!q.get("SELECT 1 FROM contract_versions WHERE contract_id = ? AND status = 'proposed'", c.id), '이미 검토 중인 변경 제안이 있습니다.', 409);
  must(str(summary).length >= 10, '변경 사유와 추가 범위를 10자 이상 적어 주세요.');
  const curV = getVersion(c.current_version_id);
  const terms = termsOf(curV);
  const rows = Object.fromEntries(milestonesOf(c.id).map((m) => [m.seq, m]));
  let changed = 0;
  const next = terms.milestones.map((m) => ({ ...m }));
  for (const ch of Array.isArray(changes) ? changes : []) {
    const seq = int(ch.seq);
    const m = next.find((x) => x.seq === seq);
    if (!m) continue;
    const amount = ch.amount === '' || ch.amount == null ? m.amount : toWon(ch.amount);
    const days = ch.days === '' || ch.days == null ? m.days : int(ch.days, m.days);
    if (amount === m.amount && days === m.days) continue;
    must(rows[seq] && UNPAID.includes(rows[seq].status), `${seq}단계는 이미 결제되어 변경할 수 없습니다.`, 409);
    must(amount >= 1000 && days >= 1 && days <= 365, '변경 금액·기간이 올바르지 않습니다.');
    m.amount = amount; m.days = days; changed++;
  }
  const add = parseMilestones(additions);
  let seq = Math.max(0, ...next.map((m) => m.seq));
  for (const a of add) next.push({ seq: ++seq, ...a });
  must(changed + add.length > 0, '변경할 내용이 없습니다. 추가 단계를 넣거나 결제 전 단계의 금액·기간을 바꾸세요.');
  const newTerms = { ...terms, milestones: next, total: next.reduce((s, m) => s + m.amount, 0) };
  const no = q.get('SELECT MAX(version_no) m FROM contract_versions WHERE contract_id = ?', c.id).m + 1;
  const id = insertVersion(c.id, no, 'change', newTerms, user, { changeSummary: summary, buyerAgreed: role === 'buyer', sellerAgreed: role === 'seller' });
  audit(user, 'contract.change_propose', 'contract_version', id, { contract_id: c.id, total_before: terms.total, total_after: newTerms.total });
  notify(role === 'buyer' ? c.seller_id : c.buyer_id, '변경 계약 제안이 도착했습니다', `${c.title} — 금액·기간 변경은 양측이 동의해야 적용됩니다.`, `/my/contracts/${c.id}`);
  return getVersion(id);
}

// 기존 범위와 새 범위 비교(화면 표시용)
function diffVersions(prevTerms, nextTerms) {
  const prev = Object.fromEntries((prevTerms?.milestones || []).map((m) => [m.seq, m]));
  const rows = nextTerms.milestones.map((m) => {
    const p = prev[m.seq];
    return { seq: m.seq, title: m.title, before: p || null, after: m, kind: !p ? 'added' : p.amount !== m.amount || p.days !== m.days ? 'changed' : 'same' };
  });
  const days = (t) => (t?.milestones || []).reduce((s, m) => s + m.days, 0);
  return { rows, totalBefore: prevTerms?.total ?? 0, totalAfter: nextTerms.total, daysBefore: days(prevTerms), daysAfter: days(nextTerms) };
}

// ── 단계 결제: 단계마다 별도의 주문·결제
function createMilestoneOrder(buyer, milestoneId) {
  const m = q.get('SELECT * FROM milestones WHERE id = ?', milestoneId);
  const c = m && getContract(m.contract_id);
  if (!c || c.buyer_id !== buyer.id) throw notFound('단계를 찾을 수 없습니다.');
  if (!providers.caps().staged_payments) throw new AppError(STAGED_UNSUPPORTED_MSG, 409, 'STAGED_UNSUPPORTED');
  must(c.status === 'active', '양측이 동의해 체결된 계약만 결제할 수 있습니다.', 409);
  const prior = q.get("SELECT seq FROM milestones WHERE contract_id = ? AND seq < ? AND status NOT IN ('approved','cancelled') ORDER BY seq", c.id, m.seq);
  must(!prior, `${prior?.seq}단계의 검수가 승인된 뒤 다음 단계를 결제할 수 있습니다.`, 409, 'PREVIOUS_NOT_APPROVED');
  must(m.status === 'awaiting_payment', '지금 결제할 수 있는 단계가 아닙니다.', 409);
  if (m.order_id) {
    const ex = orders.getOrder(m.order_id);
    if (ex && ['none', 'failed', 'cancelled', 'pending'].includes(ex.payment_status)) return ex;   // 미결제 주문 재사용
    must(false, '이미 결제된 단계입니다.', 409);
  }
  const v = getVersion(c.current_version_id);
  const terms = termsOf(v);
  const o = orders.createOrder({
    kind: 'milestone', buyer, sellerId: c.seller_id, title: `${c.title} — ${m.seq}단계 ${m.title}`, amount: m.amount,
    terms: {
      deal_type: 'custom_dev_milestone', contract_id: c.id, contract_title: c.title, contract_version: v.version_no, contract_hash: v.terms_hash,
      seq: m.seq, title: m.title, deliverables: m.deliverables, criteria: m.criteria, requires_source: !!m.requires_source,
      required_roles: m.requires_source ? ['source', 'install_doc'] : [],
      scope: terms.scope, exclusions: terms.exclusions, revision_scope: terms.revision_scope,
    },
    inspectionDays: Math.min(Math.max(int(terms.inspection_days, 7), 3), 30), deliveryDays: m.days, refs: { milestoneId: m.id },
  });
  q.update('milestones', m.id, { order_id: o.id });
  return o;
}

// 단계 주문의 검수가 끝났을 때(inspection.finish에서 호출)
function onOrderApproved(o) {
  if (!o || o.kind !== 'milestone') return;
  const m = q.get('SELECT * FROM milestones WHERE id = ?', o.milestone_id);
  if (!m) return;
  const c = getContract(m.contract_id);
  if (c.status !== 'active') return;
  const next = openNextMilestone(c.id);
  if (next) {
    notify(c.buyer_id, `${next.seq}단계 결제를 진행할 수 있습니다`, `${c.title} — 결제가 확인되면 판매자가 작업을 시작합니다.`, `/my/contracts/${c.id}`);
    notify(c.seller_id, `${m.seq}단계 검수가 승인되었습니다`, `${next.seq}단계는 구매자 결제가 확인된 뒤 시작하세요.`, `/my/contracts/${c.id}`);
  } else if (!milestonesOf(c.id).some((x) => !['approved', 'cancelled'].includes(x.status))) {
    q.update('contracts', c.id, { status: 'completed' });
    if (c.request_id) q.update('requests', c.request_id, { status: 'closed' });
    notify(c.buyer_id, '계약의 모든 단계가 완료되었습니다', c.title, `/my/contracts/${c.id}`);
    notify(c.seller_id, '계약의 모든 단계가 완료되었습니다', c.title, `/my/contracts/${c.id}`);
  }
}

// 계약 범위 밖으로 분류된 수정 요청(추가 개발 견적 대상) — 변경 계약으로 이어 준다.
function quotedRevisions(contractId) {
  return q.all(`SELECT rv.*, m.seq FROM revision_requests rv JOIN orders o ON o.id = rv.order_id JOIN milestones m ON m.id = o.milestone_id
    WHERE m.contract_id = ? AND rv.status = 'quoted' ORDER BY rv.id DESC`, contractId);
}

module.exports = {
  KINDS, MS_STATUS, STAGED_UNSUPPORTED_MSG, getRequest, getContract, getVersion, milestonesOf, termsOf, versionsOf,
  createRequest, canView, loadRequest, listPublic, cancelRequest, parseMilestones, milestonesFromForm, propose, withdrawProposal, compareProposals,
  acceptProposal, loadContract, agreeVersion, rejectVersion, proposeChange, diffVersions, createMilestoneOrder, onOrderApproved, quotedRevisions,
};
