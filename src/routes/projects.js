'use strict';
// 맞춤 개발 의뢰 · 견적 · 계약 · 단계별 결제
const r = require('express').Router();
const { q } = require('../db');
const { h, needUser } = require('../web');
const ui = require('../ui');
const { html, csrf, field, check, card, notice, tag, won, fmtDate, table, postBtn, nl2br, bullets, hashChip, dl } = ui;
const { int, must } = require('../util');
const providers = require('../providers');
const P = require('../services/projects');

const REQ_STATUS = { open: ['제안 받는 중', 'ok'], contracting: ['계약 진행 중', 'warn'], closed: ['완료', ''], cancelled: ['취소', ''] };
const PROP_STATUS = { submitted: ['검토 중', 'warn'], accepted: ['선택됨', 'ok'], declined: ['미선택', ''], withdrawn: ['철회', ''] };
const CON_STATUS = { draft: ['조건 동의 대기', 'warn'], active: ['진행 중', 'ok'], completed: ['완료', ''], cancelled: ['취소', ''] };
const VER_STATUS = { proposed: ['동의 대기', 'warn'], agreed: ['적용 중', 'ok'], rejected: ['거절됨', 'bad'], superseded: ['이전 버전', ''] };
const MS_TONE = { pending: '', awaiting_payment: 'warn', in_progress: 'warn', delivered: 'warn', revision: 'warn', approved: 'ok', cancelled: '' };
const st = (map, v) => tag(...(map[v] || [v, '']));
const budget = (x) => (x.budget_min || x.budget_max ? `${x.budget_min ? won(x.budget_min) : ''} ~ ${x.budget_max ? won(x.budget_max) : ''}` : '협의');
const sellerName = (id) => q.get('SELECT display_name FROM seller_profiles WHERE user_id = ?', id)?.display_name || q.get('SELECT name FROM users WHERE id = ?', id)?.name || '-';
const userName = (id) => q.get('SELECT name FROM users WHERE id = ?', id)?.name || '-';

// 단계 입력 줄(제목이 빈 줄은 저장하지 않는다)
const STAGE_HINTS = ['요구사항 및 화면 설계', '핵심 기능 구현', '전체 기능 및 테스트', '최종 소스·문서·배포 인도'];
function milestoneRows(prefix, n, defaults = []) {
  return html`<div class="table-wrap"><table><thead><tr><th>단계 이름</th><th>산출물</th><th>금액(원)</th><th>기간(일)</th><th>검수 기준</th><th>소스 인도</th></tr></thead><tbody>
    ${Array.from({ length: n }, (_, i) => { const d = defaults[i] || {}; return html`<tr>
      <td><input type="text" name="${prefix}title[]" value="${d.title || ''}" placeholder="${STAGE_HINTS[i] || '추가 단계'}"></td>
      <td><textarea name="${prefix}deliverables[]" rows="2" placeholder="줄마다 산출물 하나">${d.deliverables || ''}</textarea></td>
      <td><input type="text" name="${prefix}amount[]" value="${d.amount || ''}" inputmode="numeric"></td>
      <td><input type="number" name="${prefix}days[]" value="${d.days || ''}" min="1" max="365"></td>
      <td><textarea name="${prefix}criteria[]" rows="2">${d.criteria || ''}</textarea></td>
      <td><select name="${prefix}requires_source[]"><option value="0">필수 아님</option><option value="1" ${d.requires_source || (!defaults.length && i === n - 1 && prefix === 'm_') ? ui.raw('selected') : ''}>소스·실행 방법 필수</option></select></td>
    </tr>`; })}</tbody></table></div>`;
}

// ── 공개 의뢰 목록
r.get('/requests', (req, res) => {
  const rows = P.listPublic({ q: req.query.q, kind: req.query.kind });
  res.page({ title: '맞춤 개발 의뢰', body: html`
    <div class="head"><div><h1>맞춤 개발 의뢰</h1><p class="sub">필요한 프로그램을 의뢰하고 여러 판매자의 단계별 견적을 비교합니다</p></div><a class="btn primary" href="/requests/new">의뢰 등록</a></div>
    <form class="filters" method="get" action="/requests">
      <input type="search" name="q" value="${req.query.q || ''}" placeholder="검색">
      <select name="kind"><option value="">전체 유형</option>${Object.entries(P.KINDS).map(([k, l]) => html`<option value="${k}" ${req.query.kind === k ? ui.raw('selected') : ''}>${l}</option>`)}</select>
      <button class="btn">찾기</button></form>
    ${table(['의뢰', '유형', '예산', '희망 납기', '받은 제안', '등록일'], rows.map((x) => [html`<a href="/requests/${x.id}">${x.title}</a>`, P.KINDS[x.kind], budget(x), x.due_date || '협의', `${x.proposal_count}건`, fmtDate(x.created_at, false)]), '제안을 받고 있는 공개 의뢰가 없습니다')}` });
});

// ── 의뢰 등록(?product=ID 는 상품별 추가 개발 요청)
r.get('/requests/new', needUser, (req, res) => {
  const p = int(req.query.product) ? q.get("SELECT p.id, p.title, p.seller_id, sp.display_name FROM products p JOIN seller_profiles sp ON sp.user_id = p.seller_id WHERE p.id = ? AND p.status = 'approved'", int(req.query.product)) : null;
  res.page({ title: '의뢰 등록', body: html`<div class="head"><div><h1>${p ? '상품 추가 개발 요청' : '개발 의뢰 등록'}</h1><p class="sub">범위가 구체적일수록 견적과 검수 기준이 분명해집니다</p></div></div>
    ${p ? notice(html`<a href="/products/${p.id}">${p.title}</a>의 판매자 ${p.display_name}에게만 보이는 비공개 의뢰로 등록됩니다`) : ''}
    <form method="post" action="/requests/new" class="card">${csrf(req)}
      ${p ? html`<input type="hidden" name="related_product_id" value="${p.id}"><input type="hidden" name="visibility" value="private">` : ''}
      <div class="row">${field('의뢰 유형', 'kind', p ? 'customize' : 'new', { options: Object.entries(P.KINDS) })}
      ${p ? '' : field('공개 범위', 'visibility', 'public', { options: [['public', '공개 — 승인된 판매자 누구나 제안'], ['private', '비공개 — 초대한 판매자만']] })}</div>
      ${p ? '' : field('초대할 판매자 번호(비공개 의뢰)', 'invited_seller_id', req.query.seller || '', { hint: '전문가 찾기의 판매자 상점 주소에 있는 번호입니다. 공개 의뢰는 비워 두세요' })}
      ${field('제목', 'title', p ? `${p.title} 커스터마이징` : '', { required: true })}
      ${field('개발 목적', 'purpose', '', { rows: 2, hint: '어떤 업무 문제를 해결하려는지' })}
      ${field('기능 요구사항', 'requirements', '', { rows: 6, required: true, hint: '필수 기능과 있으면 좋은 기능을 구분해 적어 주세요' })}
      ${field('실행 환경', 'environment', '', { rows: 2, placeholder: '예: Windows 11 PC 설치형, 사내 서버(Ubuntu), 크롬 브라우저' })}
      <div class="row">${field('예산 하한(원)', 'budget_min', '', { attrs: 'inputmode="numeric"' })}${field('예산 상한(원)', 'budget_max', '', { attrs: 'inputmode="numeric"' })}${field('희망 납기', 'due_date', '', { type: 'date' })}</div>
      ${field('참고 자료', 'reference_notes', '', { rows: 2, hint: '참고 서비스 주소나 기존 문서 설명. 비밀 자료는 계약 후 거래 메시지로 전달하세요' })}
      ${field('소스코드 제공 조건', 'source_terms', '', { rows: 2, placeholder: '예: 최종 단계에 전체 소스와 빌드·배포 문서 인도' })}
      ${field('권리 귀속', 'rights_terms', '', { rows: 2, placeholder: '예: 결과물의 저작재산권은 대금 완납 시 의뢰자에게 양도, 판매자 범용 모듈은 이용허락', hint: '소스 파일을 받는 것과 권리를 양도받는 것은 다릅니다. 원하는 조건을 분명히 적어 주세요' })}
      ${field('유지보수', 'maintenance_terms', '', { rows: 2, placeholder: '예: 인도 후 3개월 오류 수정 포함' })}
      <button class="btn primary">의뢰 등록</button></form>` });
});
r.post('/requests/new', needUser, h(async (req, res) => { const x = P.createRequest(req.user, req.body); res.flash('의뢰를 등록했습니다'); res.redirect(`/requests/${x.id}`); }));

// ── 의뢰 상세
r.get('/requests/:id', h(async (req, res) => {
  const x = P.loadRequest(req.user, int(req.params.id));
  const mine = req.user && req.user.id === x.buyer_id;
  const sellerOk = req.user?.seller?.status === 'approved' && !mine;
  const myProp = req.user ? q.get('SELECT * FROM proposals WHERE request_id = ? AND seller_id = ?', x.id, req.user.id) : null;
  const product = x.related_product_id ? q.get('SELECT id, title FROM products WHERE id = ?', x.related_product_id) : null;
  const contract = q.get("SELECT * FROM contracts WHERE request_id = ? AND status <> 'cancelled' ORDER BY id DESC", x.id);
  const props = mine ? P.compareProposals(x.id) : [];
  const myMs = myProp ? JSON.parse(myProp.milestones_json) : [];
  res.page({ title: x.title, body: html`
    <div class="head"><div><h1>${x.title}</h1><p class="sub">${P.KINDS[x.kind]} · ${fmtDate(x.created_at, false)} 등록 · ${st(REQ_STATUS, x.status)} ${x.visibility === 'private' ? tag('비공개') : ''}</p></div>
      ${mine && x.status === 'open' ? postBtn(req, `/requests/${x.id}/cancel`, '의뢰 취소', { cls: 'sm danger' }) : ''}</div>
    ${card('의뢰 내용', dl([
      product && ['관련 상품', html`<a href="/products/${product.id}">${product.title}</a>`],
      ['개발 목적', nl2br(x.purpose) ], ['기능 요구사항', nl2br(x.requirements)], ['실행 환경', nl2br(x.environment)],
      ['예산', budget(x)], ['희망 납기', x.due_date || '협의'], ['참고 자료', nl2br(x.reference_notes)],
      ['소스코드 제공 조건', nl2br(x.source_terms)], ['권리 귀속', nl2br(x.rights_terms)], ['유지보수', nl2br(x.maintenance_terms)],
    ]))}
    ${contract && (mine || req.user?.id === contract.seller_id) ? notice(html`이 의뢰는 계약으로 이어졌습니다. <a href="/my/contracts/${contract.id}">계약 화면 열기</a>`, 'ok') : ''}
    ${mine ? card('견적 비교', html`
      <p class="sub">제안을 선택하면 계약 초안이 만들어지고, 조건에 동의해야 계약이 시작됩니다. 금액은 단계마다 따로 결제합니다</p>
      ${props.length ? html`<div class="table-wrap"><table class="compare"><thead><tr><th>항목</th>${props.map((p) => html`<th><a href="/sellers/${p.seller_id}">${p.seller_name}</a> ${st(PROP_STATUS, p.status)}</th>`)}</tr></thead><tbody>
        <tr><td>총액</td>${props.map((p) => html`<td>${won(p.total)}</td>`)}</tr>
        <tr><td>단계 수</td>${props.map((p) => html`<td>${p.milestone_count}단계</td>`)}</tr>
        <tr><td>총 기간</td>${props.map((p) => html`<td>${p.total_days}일</td>`)}</tr>
        <tr><td>단계별 금액</td>${props.map((p) => html`<td>${p.milestones.map((m, i) => html`<div>${i + 1}. ${m.title} — ${won(m.amount)} / ${m.days}일${m.requires_source ? html` ${tag('소스 인도')}` : ''}</div>`)}</td>`)}</tr>
        <tr><td>소스 인도 단계</td>${props.map((p) => html`<td>${p.source_stage ? '있음' : tag('없음 — 소스 인도가 필요하면 확인하세요', 'warn')}</td>`)}</tr>
        <tr><td>작업 범위</td>${props.map((p) => html`<td>${nl2br(p.scope)}</td>`)}</tr>
        <tr><td>제외 범위</td>${props.map((p) => html`<td>${nl2br(p.exclusions) }</td>`)}</tr>
        <tr><td>수정 범위</td>${props.map((p) => html`<td>${nl2br(p.revision_scope)}</td>`)}</tr>
        <tr><td>지원 조건</td>${props.map((p) => html`<td>${nl2br(p.support_terms)}</td>`)}</tr>
        ${x.status === 'open' ? html`<tr><td></td>${props.map((p) => html`<td>${p.status === 'submitted' ? postBtn(req, `/proposals/${p.id}/accept`, '이 제안 선택', { cls: 'sm primary' }) : ''}</td>`)}</tr>` : ''}
      </tbody></table></div>` : html`<p class="empty">아직 받은 제안이 없습니다</p>`}`) : ''}
    ${!req.user && x.status === 'open' ? notice(html`판매자로 <a href="/login?next=/requests/${x.id}">로그인</a>하면 견적을 제안할 수 있습니다`) : ''}
    ${req.user && !mine && !sellerOk && x.status === 'open' ? notice(html`판매자 심사가 승인된 뒤 제안할 수 있습니다. <a href="/my/seller">판매자 등록</a>`) : ''}
    ${myProp ? card('내 제안', html`<p>${st(PROP_STATUS, myProp.status)} 총액 ${won(myProp.total)} · ${myMs.length}단계</p>
      ${myProp.status === 'submitted' ? postBtn(req, `/proposals/${myProp.id}/withdraw`, '제안 철회', { cls: 'sm' }) : ''}`) : ''}
    ${sellerOk && x.status === 'open' && (!myProp || ['submitted', 'withdrawn'].includes(myProp.status)) ? card(myProp ? '제안 수정' : '견적 제안', html`
      <p class="sub">단계마다 산출물·금액·검수 기준을 정합니다. 단계별 금액은 단계마다 따로 결제되고, 해당 단계의 결제가 확인된 뒤 작업을 시작합니다</p>
      ${notice('결제 사업자의 보류 기간 때문에 한 단계의 납품 기한과 검수 기간의 합이 길면 결제가 막힐 수 있습니다. 긴 작업은 단계를 나누세요')}
      <form method="post" action="/requests/${x.id}/proposals">${csrf(req)}
        ${field('작업 범위', 'scope', myProp?.scope || '', { rows: 4, required: true })}
        ${field('제외 범위', 'exclusions', myProp?.exclusions || '', { rows: 2, hint: '포함하지 않는 작업을 분명히 적어 두면 계약 밖 요구에 대응할 수 있습니다' })}
        ${field('수정 범위', 'revision_scope', myProp?.revision_scope || '', { rows: 2, placeholder: '예: 단계별 검수에서 계약 범위 내 수정 2회' })}
        ${field('지원 조건', 'support_terms', myProp?.support_terms || '', { rows: 2 })}
        <h3>단계별 일정과 금액</h3>
        ${milestoneRows('m_', 5, myMs)}
        <p class="hint">제목이 빈 줄은 저장되지 않습니다. 최종 소스·실행 방법·문서를 인도하는 단계는 '소스·실행 방법 필수'로 지정하세요. 그 단계는 소스 묶음과 설치 설명서가 있어야 납품이 제출됩니다</p>
        <button class="btn primary">${myProp ? '제안 다시 제출' : '제안 제출'}</button></form>`) : ''}` });
}));
r.post('/requests/:id/cancel', needUser, h(async (req, res) => { P.cancelRequest(req.user, int(req.params.id)); res.flash('의뢰를 취소했습니다'); res.redirect('/my/requests'); }));
r.post('/requests/:id/proposals', needUser, h(async (req, res) => {
  P.propose(req.user, int(req.params.id), { ...req.body, milestones: P.milestonesFromForm(req.body, 'm_') });
  res.flash('제안을 제출했습니다'); res.redirect(`/requests/${int(req.params.id)}`);
}));
r.post('/proposals/:id/accept', needUser, h(async (req, res) => { const c = P.acceptProposal(req.user, int(req.params.id)); res.flash('계약 초안이 만들어졌습니다. 조건을 확인하고 동의해 주세요'); res.redirect(`/my/contracts/${c.id}`); }));
r.post('/proposals/:id/withdraw', needUser, h(async (req, res) => { P.withdrawProposal(req.user, int(req.params.id)); res.flash('제안을 철회했습니다'); res.back('/my/requests'); }));

// ── 내 의뢰·제안
r.get('/my/requests', needUser, (req, res) => {
  const mine = q.all(`SELECT r.*, (SELECT COUNT(*) FROM proposals p WHERE p.request_id = r.id AND p.status IN ('submitted','accepted')) AS n FROM requests r WHERE r.buyer_id = ? ORDER BY r.id DESC`, req.user.id);
  const invited = q.all("SELECT * FROM requests WHERE invited_seller_id = ? AND status = 'open' ORDER BY id DESC", req.user.id);
  const props = q.all('SELECT p.*, r.title FROM proposals p JOIN requests r ON r.id = p.request_id WHERE p.seller_id = ? ORDER BY p.id DESC', req.user.id);
  res.page({ title: '견적·의뢰', my: true, body: html`<div class="head"><h1>견적·의뢰</h1><a class="btn primary" href="/requests/new">의뢰 등록</a></div>
    ${card('내 의뢰', table(['의뢰', '상태', '받은 제안', '등록일'], mine.map((x) => [html`<a href="/requests/${x.id}">${x.title}</a>`, st(REQ_STATUS, x.status), `${x.n}건`, fmtDate(x.created_at, false)]), '등록한 의뢰가 없습니다'))}
    ${invited.length ? card('초대받은 의뢰', table(['의뢰', '예산', '희망 납기'], invited.map((x) => [html`<a href="/requests/${x.id}">${x.title}</a>`, budget(x), x.due_date || '협의']))) : ''}
    ${card('내가 낸 제안', table(['의뢰', '총액', '상태', '제출일'], props.map((p) => [html`<a href="/requests/${p.request_id}">${p.title}</a>`, won(p.total), st(PROP_STATUS, p.status), fmtDate(p.created_at, false)]), '제출한 제안이 없습니다'))}` });
});

// ── 계약
r.get('/my/contracts', needUser, (req, res) => {
  const rows = q.all('SELECT * FROM contracts WHERE buyer_id = ? OR seller_id = ? ORDER BY id DESC', req.user.id, req.user.id);
  res.page({ title: '계약·검수', my: true, body: html`<div class="head"><h1>계약·검수</h1></div>
    ${table(['계약', '내 역할', '상대방', '상태', '단계 진행', '총액'], rows.map((c) => {
      const ms = P.milestonesOf(c.id);
      const v = c.current_version_id ? P.getVersion(c.current_version_id) : q.get('SELECT * FROM contract_versions WHERE contract_id = ? ORDER BY version_no DESC', c.id);
      const buyer = c.buyer_id === req.user.id;
      return [html`<a href="/my/contracts/${c.id}">${c.title}</a>`, buyer ? '의뢰자' : '판매자', buyer ? sellerName(c.seller_id) : userName(c.buyer_id), st(CON_STATUS, c.status),
        ms.length ? `${ms.filter((m) => m.status === 'approved').length} / ${ms.length}단계 승인` : '-', v ? won(P.termsOf(v).total) : '-'];
    }), '계약이 없습니다')}` });
});

function versionTerms(t) {
  return dl([['작업 범위', nl2br(t.scope)], ['제외 범위', nl2br(t.exclusions)], ['수정 범위', nl2br(t.revision_scope)], ['지원 조건', nl2br(t.support_terms)],
    ['소스코드 제공', nl2br(t.source_terms)], ['권리 귀속', nl2br(t.rights_terms)], ['유지보수', nl2br(t.maintenance_terms)],
    ['검수 기간', `단계별 납품 후 ${t.inspection_days}일`], ['총액', html`${won(t.total)} <span class="muted">(${t.milestones.length}단계, 단계마다 별도 결제)</span>`]]);
}
// 기존 범위와 새 범위 나란히
function diffTable(d) {
  const cell = (m) => (m ? html`${won(m.amount)} · ${m.days}일` : html`<span class="muted">없음</span>`);
  const kind = { added: tag('추가 범위', 'warn'), changed: tag('금액·기간 변경', 'warn'), same: tag('변경 없음') };
  return html`${table(['단계', '기존 조건', '변경 후 조건', '구분'], d.rows.map((x) => [`${x.seq}. ${x.title}`, cell(x.before), cell(x.after), kind[x.kind]]))}
    ${dl([['총액', html`${won(d.totalBefore)} → ${won(d.totalAfter)} <span class="muted">(${d.totalAfter - d.totalBefore >= 0 ? '+' : ''}${won(d.totalAfter - d.totalBefore)})</span>`], ['총 기간', `${d.daysBefore}일 → ${d.daysAfter}일`]])}`;
}

r.get('/my/contracts/:id', needUser, h(async (req, res) => {
  const { contract: c, role } = P.loadContract(req.user, int(req.params.id));
  const versions = P.versionsOf(c.id);
  const current = c.current_version_id ? P.getVersion(c.current_version_id) : null;
  const pending = versions.find((v) => v.status === 'proposed');
  const shown = current || pending || versions[0];
  const ms = P.milestonesOf(c.id);
  const staged = providers.caps().staged_payments;
  const myCol = role === 'buyer' ? 'buyer_agreed_at' : 'seller_agreed_at';
  const quoted = c.status === 'active' ? P.quotedRevisions(c.id) : [];
  const unpaid = ms.filter((m) => ['pending', 'awaiting_payment'].includes(m.status));
  const workLink = (m) => (m.order_id ? html`<a href="${role === 'buyer' ? '/my/orders/' : '/my/sales/'}${m.order_id}">작업실</a>` : '');
  res.page({ title: c.title, my: true, body: html`
    <div class="head"><div><h1>${c.title}</h1><p class="sub">${role === 'buyer' ? `판매자 ${sellerName(c.seller_id)}` : `의뢰자 ${userName(c.buyer_id)}`} · ${st(CON_STATUS, c.status)} ${tag('법률 검토 전 초안', 'warn')}</p></div>
      ${c.request_id ? html`<a class="btn sm" href="/requests/${c.request_id}">의뢰 보기</a>` : ''}</div>
    ${notice('이 계약서는 플랫폼이 당사자의 입력으로 만든 초안이며 법률 검토를 거치지 않았습니다. 금액이 크거나 권리 양도가 포함되면 전문가 검토를 받으세요')}
    ${pending ? card(pending.kind === 'initial' ? '계약 조건 동의' : `변경 계약 제안 — 버전 ${pending.version_no}`, html`
      <p class="sub">제안자 ${userName(pending.proposed_by)} · ${fmtDate(pending.created_at)} · 조건 지문 ${hashChip(pending.terms_hash)}. 양측이 모두 동의하기 전에는 아무것도 적용되지 않습니다</p>
      ${pending.kind === 'change' ? html`<p>${nl2br(pending.change_summary)}</p>${diffTable(P.diffVersions(current ? P.termsOf(current) : null, P.termsOf(pending)))}` : versionTerms(P.termsOf(pending))}
      ${dl([['의뢰자 동의', pending.buyer_agreed_at ? fmtDate(pending.buyer_agreed_at) : '대기'], ['판매자 동의', pending.seller_agreed_at ? fmtDate(pending.seller_agreed_at) : '대기']])}
      <div class="actions mt">${pending[myCol] ? html`<span class="muted">상대방의 동의를 기다리고 있습니다</span>` : postBtn(req, `/my/contracts/${c.id}/versions/${pending.id}/agree`, '이 조건에 동의', { cls: 'primary' })}
        ${postBtn(req, `/my/contracts/${c.id}/versions/${pending.id}/reject`, pending[myCol] ? '제안 철회' : '거절', { cls: 'danger' })}</div>`) : ''}
    ${ms.length ? card('단계', html`
      <p class="sub">${role === 'seller' ? '현재 단계의 결제가 확인된 뒤 작업을 시작하세요. 결제 전에 한 작업은 보호되지 않습니다' : '현재 단계의 결제가 확인된 뒤 판매자가 작업을 시작합니다. 각 단계는 별도의 주문으로 결제·납품·검수·정산됩니다'}</p>
      ${staged ? '' : notice(P.STAGED_UNSUPPORTED_MSG, 'warn')}
      ${table(['단계', '산출물·검수 기준', '금액', '기간', '상태', ''], ms.map((m) => [
        html`${m.seq}. ${m.title}${m.requires_source ? html`<br>${tag('소스·실행 방법 필수')}` : ''}${m.added_in_version > 1 ? html`<br>${tag(`버전 ${m.added_in_version}에서 추가`)}` : ''}`,
        html`${bullets(m.deliverables)}${m.criteria ? html`<p class="hint">검수: ${m.criteria}</p>` : ''}`,
        won(m.amount), `${m.days}일`, tag(P.MS_STATUS[m.status], MS_TONE[m.status]),
        html`<div class="actions">${role === 'buyer' && m.status === 'awaiting_payment' && c.status === 'active' && staged ? postBtn(req, `/my/contracts/${c.id}/milestones/${m.id}/pay`, '이 단계 결제', { cls: 'sm primary' }) : ''}${workLink(m)}</div>`,
      ]))}`) : ''}
    ${shown ? card(`계약 조건${current ? ` — 적용 중인 버전 ${current.version_no}` : ''}`, html`${versionTerms(P.termsOf(shown))}
      <p class="hint">조건 지문 ${hashChip(shown.terms_hash, 16)} · 계약 버전의 내용은 저장 후 바꿀 수 없으며, 변경은 새 버전으로만 가능합니다</p>`) : ''}
    ${quoted.length ? card('계약 범위 밖으로 분류된 요청', html`<p class="sub">아래 요청은 판매자가 계약 범위 밖으로 분류했습니다. 반영하려면 변경 계약으로 추가 단계와 금액을 합의하세요</p>
      ${table(['단계', '요청', '판매자 답변'], quoted.map((v) => [`${v.seq}단계`, nl2br(v.content), nl2br(v.seller_response)]))}
      <p><a href="#change">변경 계약 제안으로 이동</a></p>`) : ''}
    ${c.status === 'active' && !pending ? html`<section class="card" id="change"><h2>변경 계약 제안</h2>
      <p class="sub">추가 요구사항은 기존 범위와 구분해 변경 계약으로 관리합니다. 이미 결제된 단계는 바꿀 수 없고, 금액·기간 변경은 상대방이 동의해야 적용됩니다</p>
      <form method="post" action="/my/contracts/${c.id}/change">${csrf(req)}
        ${field('변경 사유와 추가 범위', 'change_summary', '', { rows: 3, required: true })}
        ${unpaid.length ? html`<h3>결제 전 단계의 금액·기간 변경</h3>${table(['단계', '금액(원)', '기간(일)'], unpaid.map((m) => [`${m.seq}. ${m.title}`,
          html`<input type="hidden" name="c_seq[]" value="${m.seq}"><input type="text" name="c_amount[]" value="${m.amount}" inputmode="numeric">`,
          html`<input type="number" name="c_days[]" value="${m.days}" min="1" max="365">`]))}` : ''}
        <h3>추가 단계</h3>${milestoneRows('a_', 3)}
        <button class="btn mt">변경 계약 제안</button></form></section>` : ''}
    ${card('계약 버전 이력', table(['버전', '구분', '상태', '조건 지문', '의뢰자 동의', '판매자 동의', '제안'], versions.map((v) => [`v${v.version_no}`, v.kind === 'initial' ? '최초 계약' : '변경 계약', st(VER_STATUS, v.status), hashChip(v.terms_hash),
      v.buyer_agreed_at ? fmtDate(v.buyer_agreed_at) : '-', v.seller_agreed_at ? fmtDate(v.seller_agreed_at) : '-', html`${userName(v.proposed_by)}<br><span class="muted">${fmtDate(v.created_at)}</span>`])))}` });
}));
r.post('/my/contracts/:id/versions/:vid/agree', needUser, h(async (req, res) => {
  const v = P.getVersion(int(req.params.vid)); must(v && v.contract_id === int(req.params.id), '찾을 수 없습니다.', 404);
  const after = P.agreeVersion(req.user, v.id);
  res.flash(after.status === 'agreed' ? '양측 동의가 완료되어 조건이 적용되었습니다' : '동의를 기록했습니다. 상대방의 동의를 기다립니다'); res.redirect(`/my/contracts/${v.contract_id}`);
}));
r.post('/my/contracts/:id/versions/:vid/reject', needUser, h(async (req, res) => {
  const v = P.getVersion(int(req.params.vid)); must(v && v.contract_id === int(req.params.id), '찾을 수 없습니다.', 404);
  P.rejectVersion(req.user, v.id); res.flash('제안을 거절(철회)했습니다. 기존 조건은 그대로입니다'); res.redirect(`/my/contracts/${v.contract_id}`);
}));
r.post('/my/contracts/:id/milestones/:mid/pay', needUser, h(async (req, res) => {
  const m = q.get('SELECT * FROM milestones WHERE id = ? AND contract_id = ?', int(req.params.mid), int(req.params.id));
  must(m, '단계를 찾을 수 없습니다.', 404);
  const o = P.createMilestoneOrder(req.user, m.id);
  res.redirect(`/checkout/${o.id}`);
}));
r.post('/my/contracts/:id/change', needUser, h(async (req, res) => {
  const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const changes = arr(req.body.c_seq).map((seq, i) => ({ seq, amount: arr(req.body.c_amount)[i], days: arr(req.body.c_days)[i] }));
  P.proposeChange(req.user, int(req.params.id), { change_summary: req.body.change_summary, changes, additions: P.milestonesFromForm(req.body, 'a_') });
  res.flash('변경 계약을 제안했습니다. 상대방이 동의하면 적용됩니다'); res.redirect(`/my/contracts/${int(req.params.id)}`);
}));

module.exports = r;
