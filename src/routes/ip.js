'use strict';
// 지식재산권 거래 화면: 공개 매물 · 내 매물 · 거래 진행 · 운영자 등록 자료 확인
const r = require('express').Router();
const { q } = require('../db');
const { h, needUser, needSeller, needStaff, receiveFile } = require('../web');
const ui = require('../ui');
const { html, csrf, field, check, card, notice, tag, won, fmtDate, table, postBtn, nl2br, bullets, hashChip, dl } = ui;
const { int, must, notFound } = require('../util');
const ip = require('../services/ip');
const orders = require('../services/orders');
const adminnav = require('../views/adminnav');
const { scanCells } = require('../views/order');

const LSTATUS = { draft: ['작성 중', ''], pending_review: ['등록 자료 확인 대기', 'warn'], approved: ['공개 중', 'ok'], rejected: ['반려', 'bad'], suspended: ['공개 중지', 'bad'], sold: ['거래 완료', ''], deleted: ['삭제됨', ''] };
const DSTATUS = { inquiry: '상담', nda_pending: '비밀유지 합의 중', data_room: '자료 열람', terms_proposed: '조건 협의', terms_agreed: '조건 확정 · 결제 대기', paid: '결제 확인', transfer: '자산 인도', rights_check: '권리 이전 절차 확인', completed: '완료', cancelled: '취소' };
const dealTag = (l) => tag(ip.DEAL_TYPES[l.deal_type], ip.isExclusive(l.deal_type) ? 'warn' : '');
const LIMITS = '운영자 심사는 등록 항목과 제출 자료가 갖춰졌는지 확인하는 절차이며, 권리의 진정성·유효성·비침해를 보증하지 않습니다. 계약 전 당사자가 직접 권리와 기술을 확인하고 필요하면 전문가 검토를 받으세요';

// ── 공개
r.get('/ip', (req, res) => {
  const rows = ip.publicList();
  res.page({ title: '지식재산권 거래', body: html`<div class="head"><div><h1>지식재산권 거래</h1><p class="sub">저작재산권 양도, 독점·비독점 이용허락, 소프트웨어 사업 자산 양도 상담</p></div>
      <a class="btn" href="/my/ip/new">권리 매물 등록</a></div>
    ${notice(html`소스 파일을 받는 것과 권리를 넘겨받는 것은 다릅니다. 권리 양도와 이용허락은 이곳에서 별도 계약으로 다루며, 비공개 자료는 비밀유지 조건 합의와 권리자 승인 뒤에만 열람할 수 있습니다. ${LIMITS}`)}
    ${rows.length ? html`<div class="pgrid">${rows.map((l) => html`<a class="pcard" href="/ip/${l.id}"><div class="meta">${dealTag(l)}${l.locked_deal_id ? tag('독점 거래 진행 중', 'warn') : ''}</div>
      <h3>${l.title}</h3><p class="sub">${l.right_type} · ${l.seller_name}</p><p class="muted">${String(l.public_summary).slice(0, 90)}</p>
      <div class="price">${l.asking_price ? `희망가 ${won(l.asking_price)}` : '가격 협의'}</div></a>`)}</div>` : html`<p class="empty">공개된 권리 매물이 없습니다</p>`}` });
});

r.get('/ip/:id', h(async (req, res) => {
  const l = ip.getListing(req.params.id);
  const owner = req.user && l && l.seller_id === req.user.id;
  if (!l || (l.status !== 'approved' && l.status !== 'sold' && !owner)) throw notFound();
  const seller = q.get('SELECT display_name FROM seller_profiles WHERE user_id = ?', l.seller_id);
  const myDeal = req.user && q.get("SELECT id FROM ip_deals WHERE listing_id = ? AND buyer_id = ? AND status <> 'cancelled' ORDER BY id DESC", l.id, req.user.id);
  const docCount = q.get('SELECT COUNT(*) c FROM ip_documents WHERE listing_id = ?', l.id).c;
  res.page({ title: l.title, body: html`<div class="head"><div><h1>${l.title}</h1><p class="sub">${l.right_type} · <a href="/sellers/${l.seller_id}">${seller?.display_name}</a></p></div><div class="actions">${dealTag(l)}${tag(...LSTATUS[l.status])}</div></div>
    <div class="split"><div>
      ${card('공개 소개', html`<p>${nl2br(l.public_summary) || html`<span class="muted">기재 없음</span>`}</p>`)}
      ${card('권리와 거래 범위(판매자 기재)', dl([
        ['거래 유형', ip.DEAL_TYPES[l.deal_type]], ['권리 종류와 대상', html`${l.right_type} — ${nl2br(l.subject)}`],
        ['권리자 · 판매 권한', html`${l.holder} · ${l.authority}`], ['공동 권리자', l.co_owners || '없다고 기재됨'],
        ['양도·이용허락 범위', nl2br(l.scope) || '상담 시 협의'], ['기간 · 지역 · 사용 분야', `${l.term || '-'} / ${l.territory || '-'} / ${l.field_of_use || '-'}`],
        ['기존 이용허락·제약', nl2br(l.existing_licenses) || '없다고 기재됨'], ['제3자 구성요소', nl2br(l.third_party) || '없다고 기재됨'],
        ['포함 자산', bullets(l.included_assets)], ['제외 자산', bullets(l.excluded_assets)],
        ['기존 판매 내역·이용권 처리', nl2br(l.existing_sales_handling) || '기재 없음'],
      ]))}
      ${notice(LIMITS)}
    </div>
    <aside class="sticky">${card('상담', html`
      <div class="amount">${l.asking_price ? won(l.asking_price) : '가격 협의'}</div><p class="muted">희망가이며 실제 금액은 거래 조건 확정 시 정해집니다</p>
      <p class="sub">비공개 자료 ${docCount}건 — 비밀유지 조건에 양측이 동의하고 권리자가 승인한 뒤 열람할 수 있으며 모든 열람이 기록됩니다</p>
      ${l.deal_type === 'consult' ? notice('상담 전용 매물입니다. 조건 확정과 결제는 플랫폼에서 진행하지 않습니다') : ''}
      ${owner ? html`<a class="btn block" href="/my/ip/listings/${l.id}">매물 관리</a>`
        : myDeal ? html`<a class="btn primary block" href="/my/ip/deals/${myDeal.id}">진행 중인 상담 열기</a>`
        : l.status !== 'approved' ? notice('거래가 완료된 매물입니다')
        : l.locked_deal_id ? notice('독점 거래가 계약·결제 진행 중이라 새 상담을 받지 않습니다', 'warn')
        : req.user ? html`<form method="post" action="/ip/${l.id}/deals">${csrf(req)}${field('상담 내용', 'inquiry', '', { rows: 4, required: true, hint: '검토 목적과 원하는 거래 유형을 적어 주세요' })}<button class="btn primary block">상담 시작</button></form>`
        : html`<a class="btn primary block" href="/login?next=/ip/${l.id}">로그인 후 상담</a>`}
      <ol class="steps mt"><li>상담</li><li>비밀유지 조건 합의 · 자료 열람</li><li>조건 확정 · 계약(초안) 및 결제</li><li>자산 인도 · 권리 이전 절차 확인</li><li>완료 · 정산</li></ol>`)}
      ${req.user && !owner ? card('', html`<form method="post" action="/report">${csrf(req)}<input type="hidden" name="target_type" value="ip_listing"><input type="hidden" name="target_id" value="${l.id}"><input type="hidden" name="kind" value="rights_infringement">
        ${field('권리 침해가 의심되나요', 'body', '', { rows: 2, placeholder: '근거를 적어 주세요' })}<button class="btn sm">신고</button></form>`) : ''}</aside></div>` });
}));
r.post('/ip/:id/deals', needUser, h(async (req, res) => res.redirect(303, `/my/ip/deals/${ip.startDeal(req.user, int(req.params.id), req.body.inquiry)}`)));

// ── 내 매물 · 내 거래
r.get('/my/ip', needUser, (req, res) => {
  const listings = q.all("SELECT * FROM ip_listings WHERE seller_id = ? AND status <> 'deleted' ORDER BY id DESC", req.user.id);
  const deals = q.all(`SELECT d.*, l.title, l.deal_type FROM ip_deals d JOIN ip_listings l ON l.id = d.listing_id WHERE d.buyer_id = ? OR d.seller_id = ? ORDER BY d.id DESC LIMIT 100`, req.user.id, req.user.id);
  res.page({ title: '권리 거래', my: true, body: html`<div class="head"><h1>권리 거래</h1><a class="btn" href="/my/ip/new">권리 매물 등록</a></div>
    ${card('진행 중인 거래', table(['매물', '내 역할', '단계', '금액', ''], deals.map((d) => [d.title, d.buyer_id === req.user.id ? '구매' : '판매', tag(DSTATUS[d.status], d.status === 'cancelled' ? 'bad' : d.status === 'completed' ? 'ok' : 'warn'), d.price ? won(d.price) : '-', html`<a href="/my/ip/deals/${d.id}">열기</a>`]), '진행 중인 거래가 없습니다'))}
    ${card('내 매물', table(['매물', '거래 유형', '상태', ''], listings.map((l) => [html`<a href="/my/ip/listings/${l.id}">${l.title}</a>`, ip.DEAL_TYPES[l.deal_type], html`${tag(...LSTATUS[l.status])}${l.locked_deal_id ? tag('독점 거래 잠금', 'warn') : ''}`, html`<a href="/ip/${l.id}">공개 화면</a>`]), '등록한 매물이 없습니다'))}` });
});

function listingForm(req, l, action) {
  const v = (k) => l?.[k] ?? '';
  return html`<form method="post" action="${action}">${csrf(req)}
    ${card('공개 소개', html`${field('매물 이름', 'title', v('title'), { required: true })}
      ${field('공개 소개', 'public_summary', v('public_summary'), { rows: 4, hint: '누구나 볼 수 있습니다. 영업 비밀이나 소스 내용은 비공개 자료실에 올리세요' })}
      <div class="row">${field('거래 유형', 'deal_type', v('deal_type'), { options: Object.entries(ip.DEAL_TYPES) })}${field('희망가(원, 비우면 협의)', 'asking_price', v('asking_price'), { attrs: 'inputmode="numeric"' })}</div>`)}
    ${card('권리', html`<div class="row">${field('권리 종류', 'right_type', v('right_type'), { required: true, placeholder: '예: 컴퓨터프로그램 저작재산권, 상표권, 사업 자산' })}${field('권리 대상', 'subject', v('subject'), { required: true, placeholder: '예: ○○ 견적 프로그램 v2 소스 전체' })}</div>
      <div class="row">${field('권리자', 'holder', v('holder'), { required: true })}${field('판매 권한', 'authority', v('authority'), { required: true, placeholder: '예: 권리자 본인 / 권리자 위임(위임장 보유)' })}</div>
      ${field('공동 권리자', 'co_owners', v('co_owners'), { hint: '있다면 전원의 동의 여부를 적어 주세요. 없으면 비워 둡니다' })}
      ${field('기존 이용허락 또는 제약', 'existing_licenses', v('existing_licenses'), { rows: 2, hint: '이미 준 이용허락, 담보, 외주 계약상 제한 등' })}
      ${field('제3자 구성요소', 'third_party', v('third_party'), { rows: 2, hint: '오픈소스, 외부 라이브러리, 외주 제작분 등 권리가 따로 있는 부분' })}`)}
    ${card('거래 범위', html`${field('양도 또는 이용허락 범위', 'scope', v('scope'), { rows: 3 })}
      <div class="row">${field('기간', 'term', v('term'))}${field('지역', 'territory', v('territory'))}${field('사용 분야', 'field_of_use', v('field_of_use'))}</div>
      ${field('포함 자산(줄바꿈으로 구분)', 'included_assets', v('included_assets'), { rows: 3 })}${field('제외 자산(줄바꿈으로 구분)', 'excluded_assets', v('excluded_assets'), { rows: 2 })}
      ${field('기존 판매 내역과 기존 이용권의 처리', 'existing_sales_handling', v('existing_sales_handling'), { rows: 2, hint: '독점 거래라면 이미 판매한 사용권을 어떻게 할지 반드시 적어야 조건을 확정할 수 있습니다' })}`)}
    <button class="btn primary">${l ? '저장하고 다시 확인 요청' : '등록하고 확인 요청'}</button></form>`;
}
r.get('/my/ip/new', needSeller, (req, res) => res.page({ title: '권리 매물 등록', my: true, body: html`<div class="head"><div><h1>권리 매물 등록</h1><p class="sub">운영자의 등록 자료 확인 뒤 공개됩니다</p></div></div>
  ${req.user.seller.status !== 'approved' ? notice('판매자 심사가 승인된 뒤 등록할 수 있습니다', 'warn') : ''}${notice(LIMITS)}${listingForm(req, null, '/my/ip/new')}` }));
r.post('/my/ip/new', needSeller, h(async (req, res) => { const id = ip.createListing(req.user, req.body); res.flash('등록했습니다. 권리 증빙 등 비공개 자료를 올려 주세요'); res.redirect(303, `/my/ip/listings/${id}`); }));

r.get('/my/ip/listings/:id', needUser, h(async (req, res) => {
  const l = ip.ownListing(req.user, req.params.id);
  const docs = ip.documents(l.id);
  const logs = ip.accessLogs(l.id);
  res.page({ title: l.title, my: true, body: html`<div class="head"><div><h1>${l.title}</h1><p class="sub">${ip.DEAL_TYPES[l.deal_type]}</p></div><div class="actions">${tag(...LSTATUS[l.status])}${l.locked_deal_id ? html`<a class="btn sm" href="/my/ip/deals/${l.locked_deal_id}">잠금 거래 열기</a>` : ''}<a class="btn sm" href="/ip/${l.id}">공개 화면</a></div></div>
    ${l.review_note ? notice(html`운영자 메모: ${l.review_note}`, l.status === 'rejected' || l.status === 'suspended' ? 'bad' : '') : ''}
    ${card('비공개 자료실', html`<p class="sub">권리 증빙, 계약서, 소스 스냅샷 등. 비밀유지 조건에 양측이 동의하고 내가 열람을 승인한 상대방과 심사 권한 운영자만 볼 수 있습니다</p>
      ${table(['자료', '파일', '검사 결과(항목별)', ''], docs.map((d) => [d.title, html`${d.original_name} <span class="muted">${ui.size(d.size)}</span><br>${hashChip(d.sha256, 16)}`, scanCells(d), postBtn(req, `/my/ip/documents/${d.id}/link`, '다운로드', { cls: 'sm' })]), '올린 자료가 없습니다')}
      <form method="post" action="/my/ip/listings/${l.id}/documents?_csrf=${req.csrfToken}" enctype="multipart/form-data" class="row mt">
        ${field('자료 이름', 'title', '', { placeholder: '예: 저작권 등록증, 외주 계약서' })}${field('파일', 'file', '', { type: 'file', required: true })}<div class="field"><label>&nbsp;</label><button class="btn">자료 올리기</button></div></form>
      <p class="hint">운영 비밀번호, 실사용 API 키, 고객 개인정보는 넣지 마세요. 업로드 시 자동 검사합니다</p>`)}
    ${card('열람 기록', table(['일시', '열람자', '자료'], logs.map((x) => [fmtDate(x.created_at), `${x.name}${x.deal_id ? ` (거래 #${x.deal_id})` : ''}`, x.title]), '열람 기록이 없습니다'))}
    ${l.status === 'sold' || l.locked_deal_id ? notice('거래가 진행 중이거나 완료된 매물은 수정할 수 없습니다', 'warn') : html`${listingForm(req, l, `/my/ip/listings/${l.id}`)}
      <p class="mt">${postBtn(req, `/my/ip/listings/${l.id}/delete`, '매물 삭제', { cls: 'danger sm' })}</p>`}` });
}));
r.post('/my/ip/listings/:id', needUser, h(async (req, res) => { ip.updateListing(req.user, int(req.params.id), req.body); res.flash('저장했습니다. 운영자 확인 뒤 다시 공개됩니다'); res.back('/my/ip'); }));
r.post('/my/ip/listings/:id/delete', needUser, h(async (req, res) => { ip.deleteListing(req.user, int(req.params.id)); res.flash('삭제했습니다'); res.redirect(303, '/my/ip'); }));
r.post('/my/ip/listings/:id/documents', needUser, receiveFile('ip_private'), h(async (req, res) => { ip.addDocument(req.user, int(req.params.id), req.savedFile, req.body.title); res.flash('자료를 올렸습니다. 검사 결과를 확인하세요'); res.back('/my/ip'); }));
// 비공개 자료 다운로드(권한 확인 → 열람 기록 → 만료 링크)
r.post('/my/ip/documents/:id/link', needUser, h(async (req, res) => res.redirect(303, '/dl/' + ip.requestDocument(req.user, int(req.params.id), req))));

// ── 거래 진행 화면
function itemRows(n, existing = []) {
  return Array.from({ length: n }, (_, i) => html`<div class="row">
    ${field(`인도 자산 ${i + 1} 종류`, `item_type_${i}`, existing[i]?.asset_type || 'snapshot', { options: Object.entries(ip.ASSET_TYPES) })}
    ${field('내용', `item_desc_${i}`, existing[i]?.description || '', { placeholder: i === 0 ? '예: 최종 소스 스냅샷(zip)과 커밋 이력' : '' })}</div>`);
}
const readItems = (body) => Array.from({ length: 8 }, (_, i) => ({ asset_type: body[`item_type_${i}`], description: body[`item_desc_${i}`] }));

r.get('/my/ip/deals/:id', needUser, h(async (req, res) => {
  const { deal: d, role, listing: l } = ip.loadDeal(req.user, req.params.id);
  const me = req.user.id, isSeller = role === 'seller';
  const t = d.terms_json ? JSON.parse(d.terms_json) : null;
  const o = d.order_id ? orders.getOrder(d.order_id) : null;
  const stageIdx = d.status === 'paid' ? 5 : ip.STAGES.findIndex(([k]) => k === d.status);
  const canSeeDocs = isSeller || !!ip.docAccess(req.user, l);
  const docs = canSeeDocs ? ip.documents(l.id) : [];
  const its = ip.items(d.id);
  const paid = o && ['paid', 'partially_refunded'].includes(o.payment_status);
  const active = !['completed', 'cancelled'].includes(d.status);
  const base = `/my/ip/deals/${d.id}`;
  res.page({ title: `권리 거래 — ${l.title}`, my: true, body: html`
    <div class="head"><div><h1>${l.title}</h1><p class="sub">${ip.DEAL_TYPES[l.deal_type]} · ${isSeller ? '판매' : '구매'} · 거래 #${d.id}</p></div><div class="actions">${tag(DSTATUS[d.status], d.status === 'cancelled' ? 'bad' : d.status === 'completed' ? 'ok' : 'warn')}<a class="btn sm" href="/ip/${l.id}">매물 보기</a></div></div>
    ${d.status === 'cancelled' ? notice(html`취소된 거래입니다${d.cancelled_reason ? ` — ${d.cancelled_reason}` : ''}`, 'bad') : ''}
    ${card('진행 단계', html`<ol class="steps">${ip.STAGES.map(([k, label], i) => html`<li class="${d.status !== 'cancelled' && (i < stageIdx || d.status === 'completed') ? 'done' : ''}">${label}${i === stageIdx && active ? html` ${tag('현재', 'warn')}` : ''}</li>`)}</ol>`)}
    ${card('상담 내용', html`<p>${nl2br(d.inquiry)}</p><p class="hint">${fmtDate(d.created_at)} 접수. 이후 대화는 메시지에서 이어 가세요</p>`)}

    ${card('비밀유지 조건', html`
      ${d.nda_text ? html`<div class="card flat"><p>${tag('법률 검토 전 초안', 'warn')} 문구 지문 ${hashChip(d.nda_hash)}</p><p>${nl2br(d.nda_text)}</p></div>
        ${dl([['권리자 동의', d.nda_seller_at ? fmtDate(d.nda_seller_at) : '대기'], ['열람자 동의', d.nda_buyer_at ? fmtDate(d.nda_buyer_at) : '대기'], ['열람 승인', d.access_approved_at ? fmtDate(d.access_approved_at) : '대기']])}`
        : html`<p class="sub">${isSeller ? '비밀유지 조건을 제안하면 상대방이 동의한 뒤 자료 열람을 승인할 수 있습니다' : '권리자가 비밀유지 조건을 제안하면 이곳에 표시됩니다'}</p>`}
      ${d.status === 'nda_pending' && !isSeller && !d.nda_buyer_at ? html`<form method="post" action="${base}/nda/agree">${csrf(req)}<input type="hidden" name="nda_hash" value="${d.nda_hash}">${check('위 비밀유지 조건을 읽었고 동의합니다', 'agree', false, { required: true })}<button class="btn primary">동의</button></form>` : ''}
      ${d.status === 'nda_pending' && isSeller && d.nda_buyer_at && d.nda_seller_at ? postBtn(req, `${base}/access/approve`, '자료 열람 승인', { cls: 'primary' }) : ''}
      ${isSeller && ['data_room', 'terms_proposed'].includes(d.status) ? postBtn(req, `${base}/access/revoke`, '열람 승인 회수', { cls: 'sm' }) : ''}
      ${isSeller && ['inquiry', 'nda_pending'].includes(d.status) ? html`<form method="post" action="${base}/nda" class="mt">${csrf(req)}
        ${field(d.nda_text ? '조건 다시 제안(기존 동의는 무효가 됩니다)' : '비밀유지 조건', 'text', d.nda_text || ip.DEFAULT_NDA, { rows: 8, hint: '플랫폼 기본 문구는 법률 검토를 거치지 않은 초안입니다. 필요하면 수정하세요' })}<button class="btn">조건 제안</button></form>` : ''}`)}

    ${card('비공개 자료실', canSeeDocs
      ? html`${table(['자료', '파일', '검사 결과(항목별)', ''], docs.map((x) => [x.title, html`${x.original_name} <span class="muted">${ui.size(x.size)}</span><br>${hashChip(x.sha256, 16)}`, scanCells(x), postBtn(req, `/my/ip/documents/${x.id}/link`, '열람', { cls: 'sm' })]), '등록된 자료가 없습니다')}
        <p class="hint">열람할 때마다 일시와 열람자가 기록되어 권리자에게 표시됩니다. 자료는 이 거래의 검토 목적으로만 사용하세요</p>
        ${isSeller ? html`<p class="hint"><a href="/my/ip/listings/${l.id}">자료 관리·열람 기록 보기</a></p>` : ''}`
      : html`<p class="sub">비밀유지 조건에 양측이 동의하고 권리자가 열람을 승인하면 자료가 표시됩니다</p>`)}

    ${l.deal_type === 'consult' ? notice('상담 전용 매물입니다. 조건 확정·결제·자산 인도는 플랫폼 밖에서 당사자가 진행하며 플랫폼의 결제·정산 절차가 적용되지 않습니다', 'warn') : card('거래 조건', html`
      ${t ? html`<p>${tag('법률 검토 전 초안', 'warn')} 조건 지문 ${hashChip(d.terms_hash)}</p>
        ${dl([['거래 유형', ip.DEAL_TYPES[t.deal_type]], ['금액', won(t.price)], ['범위', nl2br(t.scope)], ['기간 · 지역 · 사용 분야', `${t.term || '-'} / ${t.territory || '-'} / ${t.field_of_use || '-'}`],
          ['자산 인도 기한', `결제 확인 후 ${t.transfer_days}일`], ['검수 기간', `인도 완료 후 ${t.inspection_days}일`],
          ['인도 자산', html`<ul class="list">${t.transfer_items.map((x) => html`<li>${ip.ASSET_TYPES[x.asset_type]} — ${x.description}</li>`)}</ul>`],
          ['기존 판매 내역·이용권 처리', nl2br(t.existing_sales_handling) || '기재 없음'],
          ['구매자 동의', d.terms_buyer_at ? fmtDate(d.terms_buyer_at) : '대기'], ['판매자 동의', d.terms_seller_at ? fmtDate(d.terms_seller_at) : '대기']])}` : html`<p class="sub">자료를 확인한 뒤 어느 쪽이든 거래 조건을 제안할 수 있습니다</p>`}
      ${d.status === 'terms_proposed' && d.terms_proposed_by !== me ? html`<form method="post" action="${base}/terms/agree" class="mt">${csrf(req)}<input type="hidden" name="terms_hash" value="${d.terms_hash}">
        ${ip.isExclusive(l.deal_type) ? notice('독점 거래입니다. 동의하면 이 매물은 잠기고 다른 거래는 조건을 확정할 수 없습니다. 기존 판매 내역과 기존 이용권의 처리 조건을 다시 확인하세요', 'warn') : ''}
        ${check('위 조건을 확인했고 동의합니다. 이 문서는 법률 검토 전 초안임을 이해합니다', 'agree', false, { required: true })}<button class="btn primary">조건에 동의</button></form>` : ''}
      ${d.status === 'terms_proposed' && d.terms_proposed_by === me ? notice('상대방의 동의를 기다리고 있습니다') : ''}
      ${['data_room', 'terms_proposed'].includes(d.status) ? html`<h3>${t ? '조건 다시 제안' : '조건 제안'}</h3><form method="post" action="${base}/terms">${csrf(req)}
        <div class="row">${field('금액(원)', 'price', t?.price || l.asking_price || '', { required: true, attrs: 'inputmode="numeric"' })}${field('자산 인도 기한(일)', 'transfer_days', t?.transfer_days || 10, { type: 'number' })}${field('검수 기간(일)', 'inspection_days', t?.inspection_days || 14, { type: 'number' })}</div>
        ${field('양도·이용허락 범위', 'scope', t?.scope || l.scope, { rows: 3, required: true })}
        <div class="row">${field('기간', 'term', t?.term || l.term)}${field('지역', 'territory', t?.territory || l.territory)}${field('사용 분야', 'field_of_use', t?.field_of_use || l.field_of_use)}</div>
        ${field('기존 판매 내역과 기존 이용권의 처리', 'existing_sales_handling', t?.existing_sales_handling || l.existing_sales_handling, { rows: 2 })}
        ${itemRows(6, t?.transfer_items)}
        <p class="hint">인도 기한+검수 기간+분쟁 여유일이 결제 사업자의 보류 기간을 넘으면 제안할 수 없습니다. 서비스 계정·앱 등록 자산은 제공자의 공식 이전 절차가 있어야 인도 완료로 처리됩니다</p>
        <button class="btn">조건 제안</button></form>` : ''}
      ${d.status === 'terms_agreed' ? (isSeller ? notice('조건이 확정되었습니다. 구매자의 결제를 기다립니다. 결제 확인 전에는 자산을 인도하지 마세요')
        : html`${notice('조건이 확정되었습니다. 결제하면 판매자가 자산 인도를 시작합니다')}${o ? html`<a class="btn primary" href="/checkout/${o.id}">결제 화면으로</a>` : postBtn(req, `${base}/order`, '계약 조건으로 주문 만들기', { cls: 'primary' })}`) : ''}`)}

    ${its.length && (paid || ['transfer', 'rights_check', 'completed'].includes(d.status)) ? card('자산 인도 목록', html`
      <p class="sub">항목마다 판매자의 인도 표시와 구매자의 수령 확인이 모두 있어야 합니다. 계정 비밀번호 전달만으로는 이전 완료로 처리되지 않습니다</p>
      ${its.map((it) => html`<div class="card flat"><p>${tag(ip.ASSET_TYPES[it.asset_type])} ${it.description}</p>
        ${dl([['판매자 인도', it.seller_done_at ? html`${fmtDate(it.seller_done_at)} — ${nl2br(it.seller_note)}` : '대기'],
          it.official_procedure && ['공식 이전 절차', nl2br(it.official_procedure)], it.file_id && it.seller_done_at && ['첨부 파일', o ? html`<a href="/my/orders/${o.id}">주문 화면의 납품 파일에서 받기</a>` : '-'],
          ['구매자 수령 확인', it.buyer_confirmed_at ? fmtDate(it.buyer_confirmed_at) : '대기']])}
        ${active && paid && isSeller && !it.buyer_confirmed_at ? html`<form method="post" action="/my/ip/items/${it.id}/done?_csrf=${req.csrfToken}" enctype="multipart/form-data">
          ${field('인도 방법', 'note', it.seller_done_at ? it.seller_note : '', { rows: 2, required: true, placeholder: '예: 저장소 소유권을 구매자 조직으로 이전, 이전 완료 메일 수신' })}
          ${ip.NEEDS_OFFICIAL.includes(it.asset_type) ? field('제공자의 공식 이전 절차 확인', 'official_procedure', it.official_procedure, { rows: 2, required: true, hint: '이전 가능 여부, 진행한 절차, 구매자가 확인할 방법을 적어 주세요' }) : ''}
          ${field('첨부 파일(선택)', 'file', '', { type: 'file' })}<button class="btn sm">${it.seller_done_at ? '인도 내용 수정' : '인도 완료로 표시'}</button></form>` : ''}
        ${active && paid && !isSeller && it.seller_done_at && !it.buyer_confirmed_at ? html`<div class="actions">${postBtn(req, `/my/ip/items/${it.id}/confirm`, '수령 확인', { cls: 'sm primary' })}
          <form method="post" action="/my/ip/items/${it.id}/reject" class="inline">${csrf(req)}<input name="reason" placeholder="받지 못한 사유" required> <button class="btn sm">받지 못함</button></form></div>` : ''}</div>`)}`) : ''}

    ${paid || ['rights_check', 'completed'].includes(d.status) ? card('권리 이전 절차 확인', html`
      <p class="sub">양도 계약 체결, 필요한 등록·통지, 공동 권리자 동의 등 이 거래에 필요한 절차를 판매자가 기록하고 구매자가 확인합니다. 플랫폼은 절차의 법적 효력을 판단하지 않습니다</p>
      ${d.rights_procedure_note ? dl([['진행한 절차', nl2br(d.rights_procedure_note)], ['판매자 기록', fmtDate(d.rights_seller_at)], ['구매자 확인', d.rights_buyer_at ? fmtDate(d.rights_buyer_at) : '대기']]) : ''}
      ${active && paid && isSeller ? html`<form method="post" action="${base}/rights">${csrf(req)}${field(d.rights_procedure_note ? '내용 수정(구매자 확인이 초기화됩니다)' : '진행한 권리 이전 절차', 'note', d.rights_procedure_note, { rows: 3, required: true })}<button class="btn sm">기록</button></form>` : ''}
      ${active && paid && !isSeller && d.rights_seller_at && !d.rights_buyer_at ? postBtn(req, `${base}/rights/confirm`, '권리 이전 절차 확인', { cls: 'primary sm' }) : ''}`) : ''}

    ${o ? card('결제와 검수', html`<p class="sub">돈과 납품물의 상태, 구매확정, 문제 제기는 주문 화면에서 진행합니다. 모든 자산의 수령 확인과 권리 이전 절차 확인이 끝나야 구매확정을 할 수 있습니다</p>
      ${paid ? (() => { const b = ip.transferBlockers(d); return b.length ? html`<ul class="list">${b.map((x) => html`<li>${x}</li>`)}</ul>` : html`<p>구매확정 조건을 모두 충족했습니다</p>`; })() : ''}
      <a class="btn" href="${isSeller ? `/my/sales/${o.id}` : `/my/orders/${o.id}`}">주문 화면 열기</a>`) : ''}

    ${active && (!o || ['none', 'failed', 'cancelled'].includes(o.payment_status)) ? card('거래 취소', html`<form method="post" action="${base}/cancel">${csrf(req)}${field('사유', 'reason', '')}<button class="btn danger sm">거래 취소</button></form>
      <p class="hint">결제 전에는 어느 쪽이든 취소할 수 있고 독점 잠금이 풀립니다. 결제 후에는 주문 화면의 문제 제기 절차를 이용하세요</p>`) : ''}
    ${card('', postBtn(req, `${base}/message`, '상대방과 메시지 열기', { cls: 'sm' }))}` });
}));

const dealPost = (path, fn, msg) => r.post(`/my/ip/deals/:id${path}`, needUser, h(async (req, res) => { await fn(req, int(req.params.id)); if (msg) res.flash(msg); res.back(`/my/ip/deals/${int(req.params.id)}`); }));
dealPost('/nda', (req, id) => ip.proposeNda(req.user, id, req.body.text), '비밀유지 조건을 제안했습니다');
dealPost('/nda/agree', (req, id) => { must(req.body.agree === '1', '동의란에 체크하세요.'); ip.agreeNda(req.user, id, req.body.nda_hash); }, '비밀유지 조건에 동의했습니다');
dealPost('/access/approve', (req, id) => ip.approveAccess(req.user, id), '자료 열람을 승인했습니다');
dealPost('/access/revoke', (req, id) => ip.revokeAccess(req.user, id), '열람 승인을 회수했습니다');
dealPost('/terms', (req, id) => ip.proposeTerms(req.user, id, { ...req.body, transfer_items: readItems(req.body) }), '거래 조건을 제안했습니다');
dealPost('/terms/agree', (req, id) => { must(req.body.agree === '1', '동의란에 체크하세요.'); ip.agreeTerms(req.user, id, req.body.terms_hash); }, '거래 조건이 확정되었습니다');
dealPost('/rights', (req, id) => ip.setRightsProcedure(req.user, id, req.body.note), '권리 이전 절차를 기록했습니다');
dealPost('/rights/confirm', (req, id) => ip.confirmRights(req.user, id), '권리 이전 절차를 확인했습니다');
dealPost('/cancel', (req, id) => ip.cancelDeal(req.user, id, req.body.reason), '거래를 취소했습니다');
r.post('/my/ip/deals/:id/order', needUser, h(async (req, res) => res.redirect(303, `/checkout/${ip.createDealOrder(req.user, int(req.params.id)).id}`)));
r.post('/my/ip/deals/:id/message', needUser, h(async (req, res) => {
  const { deal: d, listing: l } = ip.loadDeal(req.user, req.params.id);
  const t = require('../services/messages').open('ip', d.id, d.buyer_id, d.seller_id, `권리 거래 — ${l.title}`);
  res.redirect(303, `/my/messages/${t.id}`);
}));
r.post('/my/ip/items/:id/done', needUser, receiveFile('delivery', { required: false }), h(async (req, res) => { ip.markItemDone(req.user, int(req.params.id), { note: req.body.note, officialProcedure: req.body.official_procedure, file: req.savedFile }); res.flash('인도 완료로 표시했습니다'); res.back('/my/ip'); }));
r.post('/my/ip/items/:id/confirm', needUser, h(async (req, res) => { ip.confirmItem(req.user, int(req.params.id)); res.flash('수령을 확인했습니다'); res.back('/my/ip'); }));
r.post('/my/ip/items/:id/reject', needUser, h(async (req, res) => { ip.rejectItem(req.user, int(req.params.id), req.body.reason); res.flash('판매자에게 다시 인도를 요청했습니다'); res.back('/my/ip'); }));

// ── 운영자: 권리 매물 등록 자료 확인
const adminPage = (req, res, title, body) => res.page({ title, admin: true, adminNav: adminnav.forUser(req.user), body });
r.get('/admin/ip', needStaff('review'), (req, res) => {
  const rows = q.all(`SELECT l.*, sp.display_name FROM ip_listings l JOIN seller_profiles sp ON sp.user_id = l.seller_id WHERE l.status <> 'deleted'
    ORDER BY CASE l.status WHEN 'pending_review' THEN 0 ELSE 1 END, l.id DESC LIMIT 200`);
  adminPage(req, res, '권리 매물 심사', html`<div class="head"><div><h1>권리 매물 심사</h1><p class="sub">${LIMITS}</p></div></div>
    ${table(['매물', '판매자', '거래 유형', '상태', '등록일'], rows.map((l) => [html`<a href="/admin/ip/${l.id}">${l.title}</a>`, l.display_name, ip.DEAL_TYPES[l.deal_type], html`${tag(...LSTATUS[l.status])}${l.locked_deal_id ? tag('독점 잠금', 'warn') : ''}`, fmtDate(l.created_at, false)]), '등록된 매물이 없습니다')}`);
});
r.get('/admin/ip/:id', needStaff('review'), h(async (req, res) => {
  const l = ip.getListing(req.params.id);
  if (!l) throw notFound();
  const docs = ip.documents(l.id);
  const deals = q.all('SELECT d.*, u.name AS buyer_name FROM ip_deals d JOIN users u ON u.id = d.buyer_id WHERE d.listing_id = ? ORDER BY d.id DESC', l.id);
  const seller = q.get('SELECT display_name, status FROM seller_profiles WHERE user_id = ?', l.seller_id);
  adminPage(req, res, l.title, html`<div class="head"><div><h1>${l.title}</h1><p class="sub">${seller.display_name} · ${ip.DEAL_TYPES[l.deal_type]}</p></div><div class="actions">${tag(...LSTATUS[l.status])}</div></div>
    ${card('등록 항목(판매자 기재)', dl([['공개 소개', nl2br(l.public_summary)], ['권리 종류와 대상', html`${l.right_type} — ${nl2br(l.subject)}`], ['권리자 · 판매 권한', `${l.holder} · ${l.authority}`], ['공동 권리자', l.co_owners || '기재 없음'],
      ['범위', nl2br(l.scope)], ['기간 · 지역 · 사용 분야', `${l.term || '-'} / ${l.territory || '-'} / ${l.field_of_use || '-'}`], ['기존 이용허락·제약', nl2br(l.existing_licenses) || '기재 없음'], ['제3자 구성요소', nl2br(l.third_party) || '기재 없음'],
      ['포함 자산', bullets(l.included_assets)], ['제외 자산', bullets(l.excluded_assets)], ['기존 판매 내역 처리', nl2br(l.existing_sales_handling) || '기재 없음'], ['희망가', l.asking_price ? won(l.asking_price) : '협의']]))}
    ${card('비공개 자료(증빙)', html`${table(['자료', '파일', '검사 결과(항목별)', ''], docs.map((d) => [d.title, html`${d.original_name} <span class="muted">${ui.size(d.size)}</span>`, scanCells(d), postBtn(req, `/my/ip/documents/${d.id}/link`, '열람', { cls: 'sm' })]), '제출된 증빙 자료가 없습니다')}
      <p class="hint">운영자의 열람도 열람 기록과 감사 기록에 남습니다</p>`)}
    ${card('심사', html`<p class="sub">공개 승인은 "등록 항목과 제출 자료를 확인했다"는 뜻이며 권리 보증이 아닙니다. 공개 화면에 인증 표시를 붙이지 않습니다</p>
      <form method="post" action="/admin/ip/${l.id}/review">${csrf(req)}${field('메모(반려 시 사유 필수)', 'note', l.review_note, { rows: 2 })}
        <div class="actions"><button class="btn primary" name="approve" value="1">공개 승인</button><button class="btn danger" name="approve" value="0">반려</button></div></form>
      ${l.status === 'approved' ? html`<form method="post" action="/admin/ip/${l.id}/suspend" class="mt">${csrf(req)}${field('공개 중지 사유(권리 침해 신고 등)', 'reason', '', { required: true })}<button class="btn danger sm">공개 중지</button></form>` : ''}`)}
    ${card('이 매물의 거래', table(['거래', '구매자', '단계', '금액', '주문'], deals.map((d) => [`#${d.id}`, d.buyer_name, DSTATUS[d.status], d.price ? won(d.price) : '-', d.order_id ? html`<a href="/admin/orders/${d.order_id}">주문 보기</a>` : '-']), '거래가 없습니다'))}`);
}));
r.post('/admin/ip/:id/review', needStaff('review'), h(async (req, res) => { ip.reviewListing(req.user, int(req.params.id), { approve: req.body.approve === '1', note: req.body.note }); res.flash('심사 결과를 기록했습니다'); res.back('/admin/ip'); }));
r.post('/admin/ip/:id/suspend', needStaff('review'), h(async (req, res) => { ip.suspendListing(req.user, int(req.params.id), req.body.reason); res.flash('공개를 중지했습니다'); res.back('/admin/ip'); }));

module.exports = r;
