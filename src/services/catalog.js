'use strict';
const { q } = require('../db');
const { clock, sha256, stableStringify, must, forbidden, notFound, str, int, toWon } = require('../util');
const scanner = require('../scanner');
const { ROLES } = require('./deliveries');
const { audit, notify, notifyStaff } = require('../log');

const TEXT_FIELDS = ['title', 'summary', 'problem', 'description', 'features', 'included', 'excluded', 'screenshots', 'video_url', 'demo_url', 'environments', 'install_method', 'install_done_criteria', 'external_costs', 'third_party_licenses', 'license_notes', 'update_support', 'inspection_criteria', 'refund_policy'];
const BOOL_FIELDS = ['install_support', 'customizable', 'external_paid_required', 'lic_modify', 'lic_commercial', 'lic_redistribute', 'lic_resale'];

function own(user, productId) {
  const p = q.get('SELECT * FROM products WHERE id = ?', productId);
  if (!p || p.status === 'deleted') throw notFound();
  if (p.seller_id !== user.id) throw forbidden();
  return p;
}

function saveProduct(user, productId, body) {
  must(user.seller, '판매자 등록 후 상품을 올릴 수 있습니다.', 403);
  const row = {};
  for (const f of TEXT_FIELDS) row[f] = str(body[f], f === 'title' ? 120 : 8000);
  for (const f of BOOL_FIELDS) row[f] = body[f] ? 1 : 0;
  must(row.title.length >= 2, '상품명을 입력하세요.');
  for (const u of [row.video_url, row.demo_url, ...row.screenshots.split('\n')]) must(!u.trim() || /^https?:\/\//.test(u.trim()), '링크는 http(s) 주소로 입력하세요.');
  row.type = body.type === 'source' ? 'source' : 'license';
  row.platform = ['pc', 'web', 'mobile', 'etc'].includes(body.platform) ? body.platform : 'web';
  row.category_id = q.get('SELECT id FROM categories WHERE id = ?', int(body.category_id))?.id ?? null;
  row.inspection_days = Math.min(Math.max(int(body.inspection_days, 7), 3), 30);
  row.updated_at = clock.iso();
  if (productId) {
    const p = own(user, productId);
    // 승인된 상품의 설명을 바꾸면 다시 심사를 받는다(기존 주문은 주문 시점 조건이 고정돼 있어 영향 없음).
    if (p.status === 'approved') { row.status = 'pending_review'; notifyStaff('review', '상품 수정 재심사', row.title, `/admin/products/${p.id}`); }
    q.update('products', p.id, row);
    return p.id;
  }
  return q.insert('products', { ...row, seller_id: user.id, created_at: clock.iso() });
}

function saveOption(user, productId, body) {
  const p = own(user, productId);
  const row = {
    name: str(body.name, 80), price: toWon(body.price), term: body.term === 'term' ? 'term' : 'perpetual',
    term_days: body.term === 'term' ? Math.max(int(body.term_days, 365), 1) : null,
    seats: int(body.seats) || null, devices: int(body.devices) || null,
    includes_source: body.includes_source || p.type === 'source' ? 1 : 0, includes_install: body.includes_install ? 1 : 0,
  };
  must(row.name && row.price >= 1000, '옵션 이름과 1,000원 이상의 가격을 입력하세요.');
  return q.insert('product_options', { product_id: p.id, ...row });
}
function toggleOption(user, productId, optionId) {
  own(user, productId);
  q.run('UPDATE product_options SET active = 1 - active WHERE id = ? AND product_id = ?', optionId, productId);
}

// ── 납품 파일 버전
function draftVersion(user, productId, label) {
  const p = own(user, productId);
  let v = q.get("SELECT * FROM product_versions WHERE product_id = ? AND status = 'draft'", p.id);
  if (!v) v = q.get('SELECT * FROM product_versions WHERE id = ?', q.insert('product_versions', { product_id: p.id, label: str(label, 40) || '1.0.0', created_by: user.id, created_at: clock.iso() }));
  else if (label) q.update('product_versions', v.id, { label: str(label, 40) });
  return q.get('SELECT * FROM product_versions WHERE id = ?', v.id);
}
function addVersionFile(user, productId, file, role) {
  must(ROLES[role], '파일 종류를 선택하세요.');
  const v = draftVersion(user, productId);
  q.insert('product_version_files', { version_id: v.id, file_id: file.id, role });
  return v;
}
function removeVersionFile(user, productId, fileId) {
  const v = draftVersion(user, productId);
  q.run('DELETE FROM product_version_files WHERE version_id = ? AND file_id = ?', v.id, fileId);
}
const versionFiles = (versionId) => q.all('SELECT f.*, vf.role FROM product_version_files vf JOIN files f ON f.id = vf.file_id WHERE vf.version_id = ? ORDER BY vf.role, f.id', versionId);

function versionProblems(p, files) {
  const problems = [];
  const has = (r) => files.some((f) => f.role === r);
  const sellsSource = p.type === 'source' || !!q.get('SELECT 1 FROM product_options WHERE product_id = ? AND active = 1 AND includes_source = 1', p.id);
  if (!files.length) problems.push('실제 납품 파일을 등록해야 판매를 시작할 수 있습니다.');
  if (sellsSource && !has('source')) problems.push('소스코드를 제공하는 상품입니다. 소스코드 파일이 필요합니다.');
  if (sellsSource && !has('install_doc')) problems.push('설치 설명서가 필요합니다.');
  if (p.type === 'license' && p.platform !== 'web' && !has('executable')) problems.push('설치형·모바일 상품은 실행 파일이 필요합니다.');
  if (!has('guide') && !has('install_doc')) problems.push('이용 안내 또는 설치 설명서가 필요합니다.');
  for (const f of files) if (scanner.overall(f) === 'flagged' && !f.scan_override_by) problems.push(`검사에서 문제가 발견된 파일: ${f.original_name}`);
  return problems;
}

// 제출하면 파일 목록이 고정된다(이후 변경은 새 버전으로만).
function submitVersion(user, productId, { label, notes }) {
  const p = own(user, productId);
  const v = draftVersion(user, productId, label);
  const files = versionFiles(v.id);
  const problems = versionProblems(p, files);
  must(problems.length === 0, problems.join(' / '), 422, 'VERSION_INCOMPLETE');
  const manifest = sha256(stableStringify(files.map((f) => ({ role: f.role, name: f.original_name, size: f.size, sha256: f.sha256 }))));
  q.update('product_versions', v.id, { status: 'submitted', manifest_hash: manifest, notes: str(notes, 2000), submitted_at: clock.iso() });
  audit(user, 'version.submit', 'product_version', v.id, { manifest });
  if (p.status === 'approved') notifyStaff('review', '새 납품 버전 심사 요청', p.title, `/admin/products/${p.id}`);
  return v.id;
}

function submitForReview(user, productId) {
  const p = own(user, productId);
  must(['draft', 'rejected'].includes(p.status), '이미 심사 중이거나 승인된 상품입니다.', 409);
  must(user.seller?.status === 'approved', '판매자 심사가 승인된 뒤 상품 심사를 요청할 수 있습니다.', 403);
  const problems = [];
  if (!q.get('SELECT 1 FROM product_options WHERE product_id = ? AND active = 1', p.id)) problems.push('판매 옵션과 가격을 등록하세요.');
  if (!q.get("SELECT 1 FROM product_versions WHERE product_id = ? AND status IN ('submitted','approved')", p.id)) problems.push('납품 파일 버전을 제출하세요.');
  for (const [f, label] of [['description', '상품 설명'], ['included', '포함 범위'], ['excluded', '제외 범위'], ['environments', '지원 환경'], ['inspection_criteria', '검수 기준'], ['refund_policy', '환불·분쟁 절차']]) if (!p[f].trim()) problems.push(`${label}을(를) 입력하세요.`);
  if (p.external_paid_required && !p.external_costs.trim()) problems.push('외부 유료 서비스가 필요하다면 예상 비용을 적어 주세요.');
  must(problems.length === 0, problems.join(' / '), 422);
  q.update('products', p.id, { status: 'pending_review', updated_at: clock.iso() });
  notifyStaff('review', '상품 심사 요청', p.title, `/admin/products/${p.id}`);
}

// 운영자 심사: 상품과 제출된 최신 버전을 함께 승인/반려
function reviewProduct(admin, productId, { approve, note }) {
  const p = q.get('SELECT * FROM products WHERE id = ?', productId);
  must(p, '상품을 찾을 수 없습니다.', 404);
  const v = q.get("SELECT * FROM product_versions WHERE product_id = ? AND status = 'submitted' ORDER BY id DESC", p.id);
  if (approve) {
    const target = v || q.get("SELECT * FROM product_versions WHERE id = ? AND status = 'approved'", p.current_version_id);
    must(target, '제출된 납품 파일 버전이 없습니다.', 409);
    const files = versionFiles(target.id);
    const problems = versionProblems(p, files);
    if (q.setting('require_malware_scan') === '1' && files.some((f) => f.scan_malware !== 'passed')) problems.push('악성 파일 검사를 통과하지 않은(검사 불가 포함) 파일이 있습니다.');
    must(problems.length === 0, '승인할 수 없습니다: ' + problems.join(' / '), 422);
    q.tx(() => {
      if (v) q.update('product_versions', v.id, { status: 'approved' });
      q.update('products', p.id, { status: 'approved', current_version_id: target.id, review_note: str(note, 1000), updated_at: clock.iso() });
    });
  } else {
    must(str(note).length >= 5, '반려 사유를 적어 주세요.');
    q.tx(() => {
      if (v) q.update('product_versions', v.id, { status: 'rejected' });
      if (p.status === 'pending_review') q.update('products', p.id, { status: p.current_version_id && !v ? 'rejected' : (p.current_version_id ? 'approved' : 'rejected'), review_note: str(note, 1000) });
    });
  }
  audit(admin, 'product.review', 'product', p.id, { approve: !!approve, note, version_id: v?.id });
  notify(p.seller_id, `상품 심사 결과: ${approve ? '승인' : '반려'}`, `${p.title} ${str(note, 300)}`, `/my/products/${p.id}`);
}

function deleteProduct(user, productId) {
  const p = own(user, productId);
  // 판매만 중단한다. 기존 주문의 파일과 버전은 보관 정책 기간 동안 그대로 둔다.
  q.update('products', p.id, { status: 'deleted', updated_at: clock.iso() });
  audit(user, 'product.delete', 'product', p.id);
}
function setSalesBlock(admin, productId, blocked, reason) {
  q.update('products', productId, { sales_blocked: blocked ? 1 : 0, sales_blocked_reason: str(reason, 500) });
  audit(admin, 'product.sales_block', 'product', productId, { blocked: !!blocked, reason });
}
function overrideScan(admin, fileId, reason) {
  must(str(reason).length >= 10, '예외 승인 사유를 10자 이상 적어 주세요.');
  q.update('files', fileId, { scan_override_by: admin.id, scan_override_reason: str(reason, 500) });
  audit(admin, 'file.scan_override', 'file', fileId, { reason });
}
function addVerification(admin, productId, { kind, result, scopeNote }) {
  must(['build_check', 'run_check', 'rights_docs'].includes(kind) && ['passed', 'failed'].includes(result), '잘못된 요청입니다.');
  must(str(scopeNote).length >= 10, '무엇을 어떤 환경에서 확인했는지 범위를 적어 주세요.');
  const p = q.get('SELECT * FROM products WHERE id = ?', productId);
  q.insert('product_verifications', { product_id: p.id, version_id: p.current_version_id, kind, result, scope_note: str(scopeNote, 1000), by_user: admin.id, created_at: clock.iso() });
  audit(admin, 'product.verification', 'product', p.id, { kind, result });
}

// ── 검색
function search(f = {}) {
  const where = ["p.status = 'approved'", "sp.status = 'approved'"], args = [];
  if (f.type) { where.push('p.type = ?'); args.push(f.type); }
  if (f.category) { where.push('c.slug = ?'); args.push(f.category); }
  if (f.platform) { where.push('p.platform = ?'); args.push(f.platform); }
  if (f.q) { where.push('(p.title LIKE ? OR p.summary LIKE ? OR p.problem LIKE ?)'); const k = `%${str(f.q, 60)}%`; args.push(k, k, k); }
  if (f.source) where.push("(p.type = 'source' OR EXISTS (SELECT 1 FROM product_options o WHERE o.product_id = p.id AND o.active = 1 AND o.includes_source = 1))");
  if (f.install) where.push('p.install_support = 1');
  if (f.custom) where.push('p.customizable = 1');
  if (f.noext) where.push('p.external_paid_required = 0');
  if (f.seller) { where.push('p.seller_id = ?'); args.push(int(f.seller)); }
  if (f.verified) where.push("EXISTS (SELECT 1 FROM product_verifications v WHERE v.product_id = p.id AND v.kind = ? AND v.result = 'passed')"), args.push(['build_check', 'run_check', 'rights_docs'].includes(f.verified) ? f.verified : 'run_check');
  const having = [];
  if (f.min) { having.push('min_price >= ?'); args.push(int(f.min)); }
  if (f.max) { having.push('min_price <= ?'); args.push(int(f.max)); }
  if (f.rating) { having.push('rating >= ?'); args.push(int(f.rating)); }
  const sort = { price: 'min_price ASC', rating: 'rating DESC, reviews DESC', new: 'p.id DESC' }[f.sort] || 'p.id DESC';
  return q.all(`SELECT p.*, c.name AS category_name, sp.display_name AS seller_name,
      (SELECT MIN(price) FROM product_options o WHERE o.product_id = p.id AND o.active = 1) AS min_price,
      (SELECT ROUND(AVG(rating), 1) FROM reviews r WHERE r.product_id = p.id AND r.hidden = 0) AS rating,
      (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id AND r.hidden = 0) AS reviews
    FROM products p JOIN seller_profiles sp ON sp.user_id = p.seller_id LEFT JOIN categories c ON c.id = p.category_id
    WHERE ${where.join(' AND ')} GROUP BY p.id ${having.length ? 'HAVING ' + having.join(' AND ') : ''} ORDER BY ${sort} LIMIT 60`, ...args);
}
module.exports = { own, saveProduct, saveOption, toggleOption, draftVersion, addVersionFile, removeVersionFile, versionFiles, versionProblems, submitVersion, submitForReview, reviewProduct, deleteProduct, setSalesBlock, overrideScan, addVerification, search };
