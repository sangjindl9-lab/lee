'use strict';
// 지식재산권 거래: 상담 → 비밀유지 합의 → 자료 열람 → 조건 확정 → 계약·결제 → 자산 인도 → 권리 이전 절차 확인 → 완료
// 소스 파일 전달과 권리 이전은 서로 다른 일이다. 플랫폼은 등록 자료와 당사자 확인만 기록하며 권리를 보증하지 않는다.
const { q } = require('../db');
const { clock, sha256, stableStringify, must, forbidden, notFound, str, int, toWon, AppError } = require('../util');
const orders = require('./orders');
const access = require('./access');
const { audit, notify, notifyStaff } = require('../log');

const DEAL_TYPES = { assignment: '저작재산권 등 권리 양도', exclusive_license: '독점 이용허락', nonexclusive_license: '비독점 이용허락', consult: '거래 상담(플랫폼 결제 없음)' };
const ORDER_LABELS = {
  assignment: '권리 양도(양도 계약과 필요한 이전 절차로 권리가 이전됨 — 소스 전달만으로는 이전되지 않음)',
  exclusive_license: '독점 이용허락(권리는 권리자에게 남고 독점적으로 이용할 권한을 받음)',
  nonexclusive_license: '비독점 이용허락(권리는 권리자에게 남고 이용할 권한만 받음)',
};
const ASSET_TYPES = { repo: '소스 저장소', snapshot: '소스 스냅샷', build_docs: '빌드·배포 문서', design: '디자인 원본', domain: '도메인', service_account: '이전 가능한 서비스 자산(계정·앱 등록 등)', contracts: '관련 계약 및 권리 자료', other: '기타' };
const NEEDS_OFFICIAL = ['domain', 'service_account'];
const STAGES = [['inquiry', '상담'], ['nda_pending', '비밀유지 조건 합의'], ['data_room', '자료 열람·권리 및 기술 확인'], ['terms_proposed', '거래 조건 협의'], ['terms_agreed', '조건 확정 · 계약 및 결제'], ['transfer', '자산 인도'], ['rights_check', '권리 이전 절차 확인'], ['completed', '완료 · 정산']];
const DEFAULT_NDA = `[법률 검토 전 초안]
1. 열람자는 비공개 자료실에서 제공받은 자료(소스코드, 계약서, 권리 증빙, 매출 자료 등)를 이 거래의 검토 목적에만 사용한다.
2. 열람자는 권리자의 서면 동의 없이 자료를 제3자에게 공개·제공하지 않으며, 복제는 검토에 필요한 범위로 제한한다.
3. 거래가 성사되지 않으면 열람자는 보유한 자료와 사본을 지체 없이 삭제한다.
4. 이 의무는 열람일로부터 3년간 유지된다.
5. 이 문서는 플랫폼이 제공하는 초안이며 법률 검토를 거치지 않았다. 당사자는 필요하면 별도의 비밀유지계약을 체결한다.`;

const isExclusive = (t) => t === 'assignment' || t === 'exclusive_license';
const isReviewer = (u) => !!u?.staff && (u.staff.includes('review') || u.staff.includes('super'));
const getListing = (id) => q.get('SELECT * FROM ip_listings WHERE id = ?', id);
const getDeal = (id) => q.get('SELECT * FROM ip_deals WHERE id = ?', id);

const TEXT = ['title', 'public_summary', 'right_type', 'subject', 'holder', 'authority', 'co_owners', 'scope', 'term', 'territory', 'field_of_use', 'existing_licenses', 'third_party', 'included_assets', 'excluded_assets', 'existing_sales_handling'];
function listingRow(body) {
  const row = {};
  for (const f of TEXT) row[f] = str(body[f], f === 'title' ? 120 : 4000);
  must(row.title.length >= 2, '매물 이름을 입력하세요.');
  must(row.right_type, '권리 종류를 입력하세요.');
  must(DEAL_TYPES[body.deal_type], '거래 유형을 선택하세요.');
  row.deal_type = body.deal_type;
  must(row.holder && row.authority, '권리자와 판매 권한(권리자 본인인지, 위임받았는지)을 입력하세요.');
  must(row.subject, '권리 대상을 입력하세요.');
  row.asking_price = String(body.asking_price ?? '').trim() ? toWon(body.asking_price) : null;
  return row;
}
function ownListing(user, id) {
  const l = getListing(id);
  if (!l || l.status === 'deleted') throw notFound();
  if (l.seller_id !== user.id) throw forbidden();
  return l;
}

function createListing(user, body) {
  must(user.seller?.status === 'approved', '판매자 심사가 승인된 뒤 권리 매물을 등록할 수 있습니다.', 403);
  const id = q.insert('ip_listings', { ...listingRow(body), seller_id: user.id, status: 'pending_review', created_at: clock.iso() });
  audit(user, 'ip.listing.create', 'ip_listing', id);
  notifyStaff('review', '권리 매물 심사 요청', str(body.title, 120), `/admin/ip/${id}`);
  return id;
}
function updateListing(user, id, body) {
  const l = ownListing(user, id);
  must(l.status !== 'sold', '거래가 완료된 매물은 수정할 수 없습니다.', 409);
  must(!l.locked_deal_id, '독점 거래가 진행 중인 매물은 수정할 수 없습니다.', 409);
  // 내용을 바꾸면 다시 등록 자료 확인을 받는다.
  q.update('ip_listings', l.id, { ...listingRow(body), status: 'pending_review' });
  audit(user, 'ip.listing.update', 'ip_listing', l.id);
  notifyStaff('review', '권리 매물 수정 재심사', str(body.title, 120), `/admin/ip/${l.id}`);
}
function deleteListing(user, id) {
  const l = ownListing(user, id);
  must(!l.locked_deal_id && l.status !== 'sold', '진행 중이거나 완료된 거래가 있는 매물은 삭제할 수 없습니다.', 409);
  must(!q.get("SELECT 1 FROM ip_deals WHERE listing_id = ? AND status IN ('terms_agreed','paid','transfer','rights_check')", l.id), '진행 중인 거래가 있습니다.', 409);
  q.update('ip_listings', l.id, { status: 'deleted' });
  audit(user, 'ip.listing.delete', 'ip_listing', l.id);
}
// 운영자 심사: 등록 항목과 제출 자료를 확인했다는 기록일 뿐 권리의 진정성·유효성을 보증하지 않는다.
function reviewListing(admin, id, { approve, note }) {
  const l = getListing(id);
  must(l && ['pending_review', 'approved', 'rejected', 'suspended'].includes(l.status), '심사할 수 있는 매물이 아닙니다.', 409);
  if (!approve) must(str(note).length >= 5, '반려 사유를 적어 주세요.');
  q.update('ip_listings', l.id, { status: approve ? 'approved' : 'rejected', review_note: str(note, 1000) });
  audit(admin, 'ip.listing.review', 'ip_listing', l.id, { approve: !!approve, note: str(note, 1000) });
  notify(l.seller_id, `권리 매물 심사 결과: ${approve ? '공개 승인' : '반려'}`, `${l.title} ${str(note, 300)}`, `/my/ip/listings/${l.id}`);
}
function suspendListing(admin, id, reason) {
  must(str(reason).length >= 5, '사유를 적어 주세요.');
  const l = getListing(id);
  must(l && l.status === 'approved', '공개 중인 매물이 아닙니다.', 409);
  q.update('ip_listings', l.id, { status: 'suspended', review_note: str(reason, 1000) });
  audit(admin, 'ip.listing.suspend', 'ip_listing', l.id, { reason });
  notify(l.seller_id, '권리 매물 공개가 중지되었습니다', str(reason, 300), `/my/ip/listings/${l.id}`);
}

// ── 비공개 자료실
function addDocument(user, listingId, file, title) {
  const l = ownListing(user, listingId);
  must(file, '파일을 선택하세요.');
  const id = q.insert('ip_documents', { listing_id: l.id, file_id: file.id, title: str(title, 200) || file.original_name, created_at: clock.iso() });
  audit(user, 'ip.document.add', 'ip_listing', l.id, { document_id: id });
  return id;
}
const documents = (listingId) => q.all('SELECT d.*, f.original_name, f.size, f.sha256, f.scan_malware, f.scan_secrets, f.scan_archive FROM ip_documents d JOIN files f ON f.id = d.file_id WHERE d.listing_id = ? ORDER BY d.id', listingId);
// 열람 권한: 판매자 본인, 심사 권한 운영자, 비밀유지 양측 동의 + 열람 승인을 받은 구매자
function docAccess(user, listing) {
  if (!user || !listing) return null;
  if (listing.seller_id === user.id) return { as: 'seller', dealId: 0 };
  if (isReviewer(user)) return { as: 'staff', dealId: 0 };
  const d = q.get(`SELECT id FROM ip_deals WHERE listing_id = ? AND buyer_id = ? AND status <> 'cancelled'
    AND nda_buyer_at IS NOT NULL AND nda_seller_at IS NOT NULL AND access_approved_at IS NOT NULL ORDER BY id DESC`, listing.id, user.id);
  return d ? { as: 'buyer', dealId: d.id } : null;
}
function requestDocument(user, documentId, req) {
  const doc = q.get('SELECT * FROM ip_documents WHERE id = ?', documentId);
  const listing = doc && getListing(doc.listing_id);
  const a = docAccess(user, listing);
  if (!a) {
    if (doc) access.log(user, null, doc.file_id, 'ip', 'denied:열람 권한 없음', req);
    throw notFound();   // 권한이 없으면 존재 여부도 알리지 않는다.
  }
  q.insert('ip_access_logs', { deal_id: a.dealId, user_id: user.id, document_id: doc.id, ip: req?.ip ?? null, created_at: clock.iso() });
  if (a.as === 'staff') audit(user, 'ip.document.view', 'ip_document', doc.id, { listing_id: listing.id }, req?.ip);
  return access.issue(user, { fileId: doc.file_id, context: 'ip' }, req);
}
const accessLogs = (listingId) => q.all(`SELECT l.created_at, l.deal_id, u.name, d.title FROM ip_access_logs l JOIN ip_documents d ON d.id = l.document_id JOIN users u ON u.id = l.user_id
  WHERE d.listing_id = ? ORDER BY l.id DESC LIMIT 100`, listingId);

// ── 거래
function loadDeal(user, dealId) {
  const d = getDeal(dealId);
  if (!d || !user) throw notFound();
  const role = d.buyer_id === user.id ? 'buyer' : d.seller_id === user.id ? 'seller' : null;
  if (!role) throw notFound();
  return { deal: d, role, listing: getListing(d.listing_id) };
}
const other = (d, role) => (role === 'buyer' ? d.seller_id : d.buyer_id);
const link = (d) => `/my/ip/deals/${d.id}`;

function startDeal(user, listingId, inquiry) {
  const l = getListing(listingId);
  must(l && l.status === 'approved', '상담할 수 있는 매물이 아닙니다.', 404);
  must(l.seller_id !== user.id, '본인의 매물입니다.');
  must(!l.locked_deal_id, '독점 거래가 진행 중인 매물입니다. 해당 거래가 끝나거나 취소된 뒤 상담할 수 있습니다.', 409);
  must(str(inquiry).length >= 10, '상담 내용을 10자 이상 적어 주세요.');
  const ex = q.get("SELECT id FROM ip_deals WHERE listing_id = ? AND buyer_id = ? AND status NOT IN ('completed','cancelled')", l.id, user.id);
  if (ex) return ex.id;
  const id = q.insert('ip_deals', { listing_id: l.id, buyer_id: user.id, seller_id: l.seller_id, inquiry: str(inquiry, 3000), created_at: clock.iso() });
  audit(user, 'ip.deal.start', 'ip_deal', id);
  notify(l.seller_id, '권리 거래 상담이 접수되었습니다', l.title, `/my/ip/deals/${id}`);
  return id;
}

// 비밀유지 조건 제안(판매자). 다시 제안하면 이전 동의는 무효가 된다.
function proposeNda(user, dealId, text) {
  const { deal: d, role } = loadDeal(user, dealId);
  if (role !== 'seller') throw forbidden('비밀유지 조건은 권리자가 제안합니다.');
  must(['inquiry', 'nda_pending'].includes(d.status), '비밀유지 조건을 제안할 수 있는 단계가 아닙니다.', 409);
  const body = str(text, 8000) || DEFAULT_NDA;
  must(body.length >= 30, '비밀유지 조건을 입력하세요.');
  q.update('ip_deals', d.id, { status: 'nda_pending', nda_text: body, nda_hash: sha256(body), nda_seller_at: clock.iso(), nda_buyer_at: null, access_approved_at: null });
  audit(user, 'ip.nda.propose', 'ip_deal', d.id, { nda_hash: sha256(body) });
  notify(d.buyer_id, '비밀유지 조건이 제안되었습니다', '동의하면 권리자의 승인 후 비공개 자료를 열람할 수 있습니다.', link(d));
}
function agreeNda(user, dealId, ndaHash) {
  const { deal: d, role } = loadDeal(user, dealId);
  must(d.status === 'nda_pending' && d.nda_text, '동의할 비밀유지 조건이 없습니다.', 409);
  // 화면에서 본 문구와 저장된 문구가 같은지 확인
  must(!ndaHash || ndaHash === d.nda_hash, '비밀유지 조건이 변경되었습니다. 다시 확인해 주세요.', 409);
  q.update('ip_deals', d.id, role === 'buyer' ? { nda_buyer_at: clock.iso() } : { nda_seller_at: clock.iso() });
  audit(user, 'ip.nda.agree', 'ip_deal', d.id, { role, nda_hash: d.nda_hash });
  notify(other(d, role), '상대방이 비밀유지 조건에 동의했습니다', '', link(d));
}
function approveAccess(user, dealId) {
  const { deal: d, role } = loadDeal(user, dealId);
  if (role !== 'seller') throw forbidden();
  must(d.status === 'nda_pending' && d.nda_buyer_at && d.nda_seller_at, '비밀유지 조건에 양측이 동의한 뒤 열람을 승인할 수 있습니다.', 409);
  q.update('ip_deals', d.id, { access_approved_at: clock.iso(), status: 'data_room' });
  audit(user, 'ip.access.approve', 'ip_deal', d.id);
  notify(d.buyer_id, '비공개 자료 열람이 승인되었습니다', '모든 열람은 기록됩니다.', link(d));
}
function revokeAccess(user, dealId) {
  const { deal: d, role } = loadDeal(user, dealId);
  if (role !== 'seller') throw forbidden();
  must(['data_room', 'terms_proposed'].includes(d.status), '조건이 확정된 뒤에는 열람 승인을 회수할 수 없습니다.', 409);
  q.update('ip_deals', d.id, { access_approved_at: null, status: 'nda_pending' });
  audit(user, 'ip.access.revoke', 'ip_deal', d.id);
}

function parseItems(items) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const description = str(it?.description, 500);
    if (!description) continue;
    must(ASSET_TYPES[it.asset_type], '인도 자산의 종류를 선택하세요.');
    out.push({ asset_type: it.asset_type, description });
  }
  must(out.length >= 1, '인도할 자산을 1개 이상 적어 주세요.');
  must(out.length <= 30, '인도 자산은 30개까지 등록할 수 있습니다.');
  return out;
}

// 거래 조건 제안(어느 쪽이든). 제안자는 동의한 것으로 보고 상대방의 동의를 기다린다.
function proposeTerms(user, dealId, body) {
  const { deal: d, role, listing: l } = loadDeal(user, dealId);
  must(l.deal_type !== 'consult', '상담 전용 매물입니다. 플랫폼에서 조건 확정·결제를 진행하지 않습니다.', 409);
  must(['data_room', 'terms_proposed'].includes(d.status), '거래 조건을 제안할 수 있는 단계가 아닙니다.', 409);
  const price = toWon(body.price);
  must(price >= 10000, '거래 금액은 10,000원 이상이어야 합니다.');
  const terms = {
    deal_type: l.deal_type, price,
    scope: str(body.scope, 4000) || l.scope, term: str(body.term, 500) || l.term, territory: str(body.territory, 500) || l.territory, field_of_use: str(body.field_of_use, 500) || l.field_of_use,
    inspection_days: Math.min(Math.max(int(body.inspection_days, 14), 3), 30), transfer_days: Math.min(Math.max(int(body.transfer_days, 14), 1), 60),
    transfer_items: parseItems(body.transfer_items),
    existing_sales_handling: str(body.existing_sales_handling, 2000) || l.existing_sales_handling,
    listing: { id: l.id, title: l.title, right_type: l.right_type, subject: l.subject, holder: l.holder, authority: l.authority, co_owners: l.co_owners, existing_licenses: l.existing_licenses, third_party: l.third_party, included_assets: l.included_assets, excluded_assets: l.excluded_assets },
    draft_notice: '법률 검토 전 초안',
  };
  must(terms.scope, '양도 또는 이용허락 범위를 입력하세요.');
  if (isExclusive(l.deal_type)) must(terms.existing_sales_handling, '독점 거래입니다. 기존 판매 내역과 기존 이용권을 어떻게 처리할지 적어 주세요.');
  // 결제 사업자의 보류 기간 안에 인도와 검수를 마칠 수 있는 일정인지 미리 확인한다.
  const sched = orders.scheduleCheck(terms.transfer_days, terms.inspection_days);
  if (!sched.ok) throw new AppError('이 일정으로는 결제를 받을 수 없습니다. ' + sched.problems.join(' '), 409, 'SCHEDULE_CONFLICT');
  const json = stableStringify(terms), now = clock.iso();
  q.update('ip_deals', d.id, { status: 'terms_proposed', terms_json: json, terms_hash: sha256(json), terms_proposed_by: user.id, price,
    terms_buyer_at: role === 'buyer' ? now : null, terms_seller_at: role === 'seller' ? now : null });
  audit(user, 'ip.terms.propose', 'ip_deal', d.id, { terms_hash: sha256(json), price });
  notify(other(d, role), '거래 조건이 제안되었습니다', `${l.title} · ${price.toLocaleString('ko-KR')}원`, link(d));
}

// 조건 확정. 독점 거래는 이 시점에 매물을 잠가 중복 판매를 막는다.
function agreeTerms(user, dealId, termsHash) {
  const { role } = loadDeal(user, dealId);
  let d, l;
  q.txi(() => {
    d = getDeal(dealId);
    l = getListing(d.listing_id);
    must(d.status === 'terms_proposed' && d.terms_json, '동의할 거래 조건이 없습니다.', 409);
    must(d.terms_proposed_by !== user.id, '상대방이 제안한 조건에만 동의할 수 있습니다.', 403);
    must(!termsHash || termsHash === d.terms_hash, '거래 조건이 변경되었습니다. 다시 확인해 주세요.', 409);
    must(l.status === 'approved', '현재 거래할 수 없는 매물입니다.', 409);
    if (isExclusive(l.deal_type)) {
      if (l.locked_deal_id && l.locked_deal_id !== d.id) throw new AppError('이 매물은 다른 독점 거래가 계약·결제 진행 중이라 잠겨 있습니다.', 409, 'LISTING_LOCKED');
      q.update('ip_listings', l.id, { locked_deal_id: d.id });
    }
    const now = clock.iso();
    q.update('ip_deals', d.id, { status: 'terms_agreed', ...(role === 'buyer' ? { terms_buyer_at: now } : { terms_seller_at: now }) });
    q.run('DELETE FROM ip_transfer_items WHERE deal_id = ?', d.id);
    for (const it of JSON.parse(d.terms_json).transfer_items) q.insert('ip_transfer_items', { deal_id: d.id, asset_type: it.asset_type, description: it.description });
  });
  audit(user, 'ip.terms.agree', 'ip_deal', d.id, { terms_hash: d.terms_hash, locked: isExclusive(l.deal_type) });
  notify(other(d, role), '거래 조건이 확정되었습니다', isExclusive(l.deal_type) ? '독점 거래이므로 매물이 잠겼습니다. 구매자의 결제를 기다립니다.' : '구매자의 결제를 기다립니다.', link(d));
  return getDeal(d.id);
}

function unlock(deal) { q.run('UPDATE ip_listings SET locked_deal_id = NULL WHERE id = ? AND locked_deal_id = ?', deal.listing_id, deal.id); }

function cancelDeal(user, dealId, reason) {
  const { deal: d, role } = loadDeal(user, dealId);
  must(!['completed', 'cancelled'].includes(d.status), '이미 끝난 거래입니다.', 409);
  const o = d.order_id ? orders.getOrder(d.order_id) : null;
  must(!o || ['none', 'failed', 'cancelled'].includes(o.payment_status), '결제가 진행된 거래는 직접 취소할 수 없습니다. 주문 화면에서 문제 제기를 해 주세요.', 409);
  q.tx(() => { q.update('ip_deals', d.id, { status: 'cancelled', cancelled_reason: str(reason, 500) || '당사자 취소' }); unlock(d); });
  audit(user, 'ip.deal.cancel', 'ip_deal', d.id, { reason: str(reason, 500) });
  notify(other(d, role), '권리 거래가 취소되었습니다', str(reason, 300), link(d));
}

// 조건 확정 후 구매자가 주문을 만든다(결제는 /checkout 재사용).
function createDealOrder(user, dealId) {
  const { deal: d, role, listing: l } = loadDeal(user, dealId);
  if (role !== 'buyer') throw forbidden('구매자만 결제를 진행할 수 있습니다.');
  must(d.status === 'terms_agreed', '거래 조건이 확정된 뒤 결제할 수 있습니다.', 409);
  if (d.order_id) return orders.getOrder(d.order_id);
  const t = JSON.parse(d.terms_json);
  const o = orders.createOrder({
    kind: 'ip', buyer: user, sellerId: d.seller_id, title: `${l.title} — ${DEAL_TYPES[l.deal_type]}`, amount: d.price,
    terms: {
      deal_type: l.deal_type, deal_type_label: ORDER_LABELS[l.deal_type], subject: `${l.right_type} · ${l.subject}`,
      scope: t.scope, term: t.term, territory: t.territory, field_of_use: t.field_of_use,
      included_assets: l.included_assets, excluded_assets: l.excluded_assets, existing_licenses: l.existing_licenses,
      existing_sales_handling: t.existing_sales_handling, transfer_items: t.transfer_items, terms_hash: d.terms_hash, nda_hash: d.nda_hash,
      holder: l.holder, authority: l.authority, co_owners: l.co_owners, third_party: l.third_party, draft_notice: '법률 검토 전 초안',
    },
    inspectionDays: t.inspection_days, deliveryDays: t.transfer_days, refs: { ipDealId: d.id }, extraVerification: isExclusive(l.deal_type),
  });
  q.update('ip_deals', d.id, { order_id: o.id });
  return o;
}

// ── 자산 인도
const items = (dealId) => q.all('SELECT * FROM ip_transfer_items WHERE deal_id = ? ORDER BY id', dealId);
const PW = /(비밀\s*번호|패스워드|비번|암호|password|passwd)/i;
const PW_ALL = new RegExp(PW.source, 'gi');
const FILLER = /(전달|공유|알려|드림|드렸|줌|줬|완료|했습니다|하였습니다|했음|함|로|를|을|는|은|\s|[.,·!:])/g;
// 내용이 사실상 "비밀번호를 전달했다"뿐인지
const onlyPassword = (s) => PW.test(s) && s.replace(PW_ALL, '').replace(FILLER, '').length < 6;

function dealForTransfer(user, itemId, need) {
  const it = q.get('SELECT * FROM ip_transfer_items WHERE id = ?', itemId);
  if (!it) throw notFound();
  const ctx = loadDeal(user, it.deal_id);
  if (ctx.role !== need) throw forbidden();
  must(['transfer', 'rights_check'].includes(ctx.deal.status), '결제가 확인된 뒤 자산 인도를 진행할 수 있습니다.', 409);
  const o = orders.getOrder(ctx.deal.order_id);
  must(o && ['paid', 'partially_refunded'].includes(o.payment_status), '결제가 확인된 거래가 아닙니다.', 409);
  return { ...ctx, item: it, order: o };
}

function markItemDone(user, itemId, { note, officialProcedure, file } = {}) {
  const { deal: d, item: it, order: o } = dealForTransfer(user, itemId, 'seller');
  must(!it.buyer_confirmed_at, '구매자가 이미 수령을 확인한 항목입니다.', 409);
  const memo = str(note, 2000), proc = str(officialProcedure, 2000);
  must(memo.length >= 5, '어떻게 인도했는지 적어 주세요.');
  if (NEEDS_OFFICIAL.includes(it.asset_type)) {
    must(proc.length >= 10, '도메인·서비스 자산은 해당 제공자의 공식 이전 절차(이전 가능 여부, 진행한 절차, 확인 방법)를 적어야 합니다. 계정 비밀번호 전달만으로는 이전 완료로 처리되지 않습니다.', 422, 'OFFICIAL_PROCEDURE_REQUIRED');
    must(!onlyPassword(proc), '비밀번호 전달은 공식 이전 절차가 아닙니다. 제공자가 정한 소유권·관리 권한 이전 절차를 적어 주세요.', 422, 'OFFICIAL_PROCEDURE_REQUIRED');
  }
  must(!onlyPassword(memo) || proc.length >= 10, '비밀번호 전달만으로는 인도 완료로 처리되지 않습니다. 실제 인도 방법이나 공식 이전 절차를 적어 주세요.', 422, 'PASSWORD_ONLY');
  q.update('ip_transfer_items', it.id, { seller_done_at: clock.iso(), seller_note: memo, official_procedure: proc, file_id: file?.id ?? it.file_id });
  audit(user, 'ip.item.done', 'ip_deal', d.id, { item_id: it.id });
  notify(d.buyer_id, '자산 인도 항목이 완료로 표시되었습니다', it.description, link(d));
  // 모든 항목이 인도 표시되면 납품 완료 → 검수 기간 시작
  if (items(d.id).every((x) => x.seller_done_at) && o.delivery_status !== 'delivered') {
    q.update('orders', o.id, { delivery_status: 'delivered', delivered_at: clock.iso() });
    orders.startInspection(o.id);
  }
}
function confirmItem(user, itemId) {
  const { deal: d, item: it } = dealForTransfer(user, itemId, 'buyer');
  must(it.seller_done_at, '판매자가 아직 인도 완료로 표시하지 않았습니다.', 409);
  q.update('ip_transfer_items', it.id, { buyer_confirmed_at: clock.iso() });
  audit(user, 'ip.item.confirm', 'ip_deal', d.id, { item_id: it.id });
  notify(d.seller_id, '구매자가 자산 수령을 확인했습니다', it.description, link(d));
}
// 구매자가 수령을 확인하지 못하겠다고 되돌리는 경우(판매자가 다시 인도 표시해야 함)
function rejectItem(user, itemId, reason) {
  const { deal: d, item: it } = dealForTransfer(user, itemId, 'buyer');
  must(it.seller_done_at && !it.buyer_confirmed_at, '되돌릴 수 있는 항목이 아닙니다.', 409);
  must(str(reason).length >= 5, '수령하지 못한 사유를 적어 주세요.');
  q.update('ip_transfer_items', it.id, { seller_done_at: null, seller_note: `[구매자 반려] ${str(reason, 500)} / 이전 메모: ${it.seller_note}`.slice(0, 2000) });
  audit(user, 'ip.item.reject', 'ip_deal', d.id, { item_id: it.id, reason: str(reason, 500) });
  notify(d.seller_id, '구매자가 자산 수령을 확인하지 못했습니다', str(reason, 300), link(d));
}

// 권리 이전 절차 확인(양도 계약 체결, 필요한 등록·통지 등). 판매자가 기록하고 구매자가 확인한다.
function setRightsProcedure(user, dealId, note) {
  const { deal: d, role } = loadDeal(user, dealId);
  if (role !== 'seller') throw forbidden();
  must(['transfer', 'rights_check'].includes(d.status), '결제가 확인된 뒤 기록할 수 있습니다.', 409);
  must(str(note).length >= 10, '어떤 권리 이전 절차를 진행했는지(계약 체결, 등록·통지, 필요한 동의 등) 10자 이상 적어 주세요.');
  q.update('ip_deals', d.id, { rights_procedure_note: str(note, 3000), rights_seller_at: clock.iso(), rights_buyer_at: null, status: 'rights_check' });
  audit(user, 'ip.rights.record', 'ip_deal', d.id);
  notify(d.buyer_id, '권리 이전 절차 확인 요청', '내용을 확인해 주세요.', link(d));
}
function confirmRights(user, dealId) {
  const { deal: d, role } = loadDeal(user, dealId);
  if (role !== 'buyer') throw forbidden();
  must(d.status === 'rights_check' && d.rights_seller_at && d.rights_procedure_note, '판매자가 권리 이전 절차를 아직 기록하지 않았습니다.', 409);
  q.update('ip_deals', d.id, { rights_buyer_at: clock.iso() });
  audit(user, 'ip.rights.confirm', 'ip_deal', d.id);
  notify(d.seller_id, '구매자가 권리 이전 절차를 확인했습니다', '', link(d));
}

// 구매확정 전 조건(inspection.confirm이 호출)
function transferBlockers(deal) {
  const b = [];
  const its = items(deal.id);
  if (!its.length || its.some((x) => !x.seller_done_at)) b.push('판매자가 인도하지 않은 자산 항목이 있습니다');
  if (its.some((x) => !x.buyer_confirmed_at)) b.push('구매자가 수령을 확인하지 않은 자산 항목이 있습니다');
  if (!deal.rights_seller_at || !deal.rights_buyer_at) b.push('권리 이전 절차를 양측이 확인하지 않았습니다');
  return b;
}
function assertTransferComplete(o) {
  if (o.kind !== 'ip') return;
  const d = getDeal(o.ip_deal_id);
  must(d, '연결된 권리 거래를 찾을 수 없습니다.', 409);
  const b = transferBlockers(d);
  if (b.length) throw new AppError('아직 구매확정을 할 수 없습니다: ' + b.join(', '), 409, 'TRANSFER_INCOMPLETE');
}
function onOrderApproved(o) {
  if (o.kind !== 'ip') return;
  const d = getDeal(o.ip_deal_id);
  if (!d || d.status === 'completed') return;
  q.update('ip_deals', d.id, { status: 'completed' });
  const l = getListing(d.listing_id);
  // 양도·독점 거래가 끝난 매물은 다시 팔 수 없다(잠금 유지).
  if (isExclusive(l.deal_type)) q.update('ip_listings', l.id, { status: 'sold' });
}
function onOrderRefunded(o) {
  if (o.kind !== 'ip') return;
  const d = getDeal(o.ip_deal_id);
  if (!d) return;
  q.update('ip_deals', d.id, { status: 'cancelled', cancelled_reason: '환불 완료' });
  unlock(d);
  q.run("UPDATE ip_listings SET status = 'approved' WHERE id = ? AND status = 'sold' AND locked_deal_id IS NULL", d.listing_id);
}

const publicList = () => q.all(`SELECT l.*, sp.display_name AS seller_name FROM ip_listings l JOIN seller_profiles sp ON sp.user_id = l.seller_id
  WHERE l.status = 'approved' AND sp.status = 'approved' ORDER BY l.id DESC LIMIT 100`);

module.exports = {
  DEAL_TYPES, ORDER_LABELS, ASSET_TYPES, NEEDS_OFFICIAL, STAGES, DEFAULT_NDA, isExclusive, getListing, getDeal, ownListing,
  createListing, updateListing, deleteListing, reviewListing, suspendListing,
  addDocument, documents, docAccess, requestDocument, accessLogs,
  loadDeal, startDeal, proposeNda, agreeNda, approveAccess, revokeAccess, proposeTerms, agreeTerms, cancelDeal, createDealOrder,
  items, markItemDone, confirmItem, rejectItem, setRightsProcedure, confirmRights, transferBlockers,
  assertTransferComplete, onOrderApproved, onOrderRefunded, publicList,
};
