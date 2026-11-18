'use strict';
// 판매자: 상점 등록, 상품·옵션·납품 파일 버전, 정산·계좌
const r = require('express').Router();
const { q } = require('../db');
const { h, needUser, needSeller, receiveFile } = require('../web');
const ui = require('../ui');
const { html, csrf, field, check, card, notice, badge, tag, won, fmtDate, table, postBtn, hashChip, bpsPct } = ui;
const { must, int, str, toWon } = require('../util');
const accounts = require('../services/accounts');
const catalog = require('../services/catalog');
const fees = require('../services/fees');
const { ROLES } = require('../services/deliveries');
const V = require('../views/order');

// ── 판매자 등록
r.get('/my/seller', needUser, (req, res) => {
  const s = req.user.seller || {};
  res.page({ title: '판매자 정보', my: true, body: html`<div class="head"><div><h1>판매자 정보</h1>${s.status ? html`<p>${badge('seller', s.status)} ${s.review_note || ''}</p>` : html`<p class="sub">판매자로 등록하면 상품 판매, 견적 제안, 권리 매물 등록을 할 수 있습니다. 운영자 심사 후 활성화됩니다</p>`}</div>
      ${s.status === 'approved' ? html`<a class="btn sm" href="/sellers/${req.user.id}">내 상점 보기</a>` : ''}</div>
    <form method="post" action="/my/seller" class="card">${csrf(req)}
      ${field('상점 이름', 'displayName', s.display_name, { required: true })}
      <div class="row">${field('구분', 'bizType', s.biz_type, { options: [['individual', '개인'], ['sole', '개인사업자'], ['corp', '법인']] })}${field('사업자등록번호', 'bizNo', s.biz_no, { hint: '사업자인 경우' })}</div>
      ${field('소개', 'intro', s.intro, { rows: 4 })}${field('기술·분야', 'skills', s.skills, { hint: '쉼표로 구분. 예: Node.js, 엑셀 자동화, ERP' })}
      ${field('포트폴리오', 'portfolio', s.portfolio, { rows: 5, hint: '한 줄에 한 항목. 실제 수행한 작업만 적어 주세요' })}
      <button class="btn primary">${s.status ? '저장' : '판매자 등록 신청'}</button></form>` });
});
r.post('/my/seller', needUser, h(async (req, res) => { accounts.applySeller(req.user, req.body); res.flash('저장했습니다'); res.back(); }));

// ── 상품 목록
r.get('/my/products', needSeller, (req, res) => {
  const ps = q.all("SELECT p.*, (SELECT MIN(price) FROM product_options o WHERE o.product_id = p.id AND o.active = 1) AS min_price FROM products p WHERE seller_id = ? AND status <> 'deleted' ORDER BY id DESC", req.user.id);
  res.page({ title: '내 상품', my: true, body: html`<div class="head"><h1>내 상품</h1><a class="btn primary" href="/my/products/new">상품 등록</a></div>
    ${req.user.seller.status !== 'approved' ? notice('판매자 심사가 끝나야 상품 심사를 요청할 수 있습니다. 그 전에도 작성은 가능합니다', 'warn') : ''}
    ${table(['상품', '유형', '가격', '상태', ''], ps.map((p) => [html`<a href="/my/products/${p.id}">${p.title}</a>${p.sales_blocked ? html` ${tag('신규 판매 제한', 'bad')}` : ''}`, p.type === 'source' ? '소스코드' : '사용권', p.min_price ? `${won(p.min_price)} 부터` : '-', html`${badge('product', p.status)}${p.review_note ? html`<br><span class="muted">${p.review_note}</span>` : ''}`, html`<a href="/products/${p.id}">미리보기</a>`]), '등록한 상품이 없습니다')}` });
});

function productForm(req, p = {}) {
  const cats = q.all('SELECT * FROM categories ORDER BY sort').map((c) => [c.id, c.name]);
  return html`<form method="post" action="${p.id ? `/my/products/${p.id}` : '/my/products/new'}" class="card">${csrf(req)}
    <h2>기본 정보</h2>
    <div class="row">${field('거래 유형', 'type', p.type, { options: [['license', '프로그램 사용권'], ['source', '소스코드']] })}${field('분야', 'category_id', p.category_id, { options: [['', '선택'], ...cats] })}${field('사용 환경', 'platform', p.platform, { options: [['web', '웹서비스'], ['pc', 'PC 설치형'], ['mobile', '모바일 앱'], ['etc', '기타']] })}</div>
    ${field('상품명', 'title', p.title, { required: true })}${field('한 줄 설명', 'summary', p.summary)}
    ${field('해결하는 업무 문제', 'problem', p.problem, { rows: 3 })}${field('상품 설명', 'description', p.description, { rows: 5 })}
    ${field('기능 목록', 'features', p.features, { rows: 5, hint: '한 줄에 한 기능' })}
    <div class="row">${field('포함 범위', 'included', p.included, { rows: 4, hint: '한 줄에 한 항목' })}${field('제외 범위', 'excluded', p.excluded, { rows: 4, hint: '제공하지 않는 것을 분명히 적어 주세요' })}</div>
    ${field('실제 화면 이미지 주소', 'screenshots', p.screenshots, { rows: 3, hint: '한 줄에 하나, https 주소. 실제 제품 화면만 올려 주세요' })}
    <div class="row">${field('영상 주소', 'video_url', p.video_url, { type: 'url' })}${field('체험 링크', 'demo_url', p.demo_url, { type: 'url' })}</div>
    <h2>환경과 비용</h2>
    ${field('지원 환경', 'environments', p.environments, { rows: 2, hint: '운영체제, 런타임 버전, DB 등 실행을 보장하는 환경' })}${field('설치·배포 방법', 'install_method', p.install_method, { rows: 2 })}
    ${check('설치 지원 제공(옵션에서 포함 여부 선택)', 'install_support', p.install_support)}${field('설치 완료 조건', 'install_done_criteria', p.install_done_criteria, { hint: '예: 구매자 서버에서 로그인 화면이 열리고 샘플 견적서 1건이 출력됨' })}
    ${check('커스터마이징(추가 개발) 가능', 'customizable', p.customizable)}
    ${check('외부 유료 서비스(API·서버·구독)가 필요함', 'external_paid_required', p.external_paid_required)}${field('외부 비용 내역', 'external_costs', p.external_costs, { rows: 2, hint: '서비스 이름과 예상 월 비용. 고지하지 않은 비용은 분쟁 사유가 됩니다' })}
    ${field('제3자 라이선스·오픈소스', 'third_party_licenses', p.third_party_licenses, { rows: 2 })}
    <h2>권리 범위</h2>
    ${notice('이 상품은 사용권 또는 소스 인도 거래입니다. 저작권 등 권리를 넘기려면 지식재산권 거래로 등록하세요')}
    ${check('수정 허용', 'lic_modify', p.lic_modify)}${check('상업적 이용 허용', 'lic_commercial', p.lic_commercial)}${check('재배포 허용', 'lic_redistribute', p.lic_redistribute)}${check('재판매 허용', 'lic_resale', p.lic_resale)}
    ${field('라이선스 조건', 'license_notes', p.license_notes, { rows: 2 })}${field('업데이트·지원 기간', 'update_support', p.update_support, { rows: 2 })}
    <h2>검수와 환불</h2>
    ${field('검수 기준', 'inspection_criteria', p.inspection_criteria, { rows: 3, hint: '구매자가 예/아니오로 확인할 수 있게 적어 주세요. 주문 시 이 기준이 고정됩니다' })}
    ${field('검수 기간(일)', 'inspection_days', p.inspection_days ?? 7, { type: 'number', attrs: 'min="3" max="30"' })}
    ${field('환불·분쟁 절차', 'refund_policy', p.refund_policy, { rows: 3 })}
    <button class="btn primary">${p.id ? '저장' : '등록하고 파일 올리기'}</button>
    ${p.status === 'approved' ? html`<p class="hint">판매 중인 상품의 설명을 바꾸면 다시 심사를 받습니다. 기존 주문에는 주문 시점 조건이 그대로 적용됩니다</p>` : ''}
    <p class="hint"><a href="/ai/draft?kind=product_description">AI 초안 도우미</a>를 선택적으로 쓸 수 있습니다</p></form>`;
}
r.get('/my/products/new', needSeller, (req, res) => res.page({ title: '상품 등록', my: true, body: html`<div class="head"><h1>상품 등록</h1></div>${productForm(req)}` }));
r.post('/my/products/new', needSeller, h(async (req, res) => res.redirect(`/my/products/${catalog.saveProduct(req.user, null, req.body)}`)));

r.get('/my/products/:id', needSeller, h(async (req, res) => {
  const p = catalog.own(req.user, int(req.params.id));
  const opts = q.all('SELECT * FROM product_options WHERE product_id = ? ORDER BY id', p.id);
  const versions = q.all('SELECT * FROM product_versions WHERE product_id = ? ORDER BY id DESC', p.id);
  const draft = versions.find((v) => v.status === 'draft');
  const dfiles = draft ? catalog.versionFiles(draft.id) : [];
  const problems = catalog.versionProblems(p, dfiles);
  const vStatus = { draft: ['작성 중', ''], submitted: ['심사 대기', 'warn'], approved: ['승인', 'ok'], rejected: ['반려', 'bad'] };
  res.page({ title: p.title, my: true, body: html`
    <div class="head"><div><h1>${p.title}</h1><p>${badge('product', p.status)} ${p.review_note || ''}</p></div>
      <div class="actions"><a class="btn sm" href="/products/${p.id}">미리보기</a>${['draft', 'rejected'].includes(p.status) ? postBtn(req, `/my/products/${p.id}/submit`, '심사 요청', { cls: 'primary sm' }) : ''}${postBtn(req, `/my/products/${p.id}/delete`, '판매 종료', { cls: 'danger sm' })}</div></div>
    ${card('판매 옵션과 예상 정산액', html`
      ${table(['옵션', '가격', '조건', '플랫폼 수수료', '예상 정산액', ''], opts.map((o) => { const f = fees.quote(o.price, p.seller_id, p.category_id); return [o.name, won(o.price), `${o.term === 'term' ? `기간제 ${o.term_days}일` : '영구'}${o.seats ? ` · ${o.seats}명` : ''}${o.devices ? ` · ${o.devices}대` : ''}${o.includes_source ? ' · 소스 포함' : ''}${o.includes_install ? ' · 설치 지원' : ''}`, `${won(f.fee_amount)} (${bpsPct(f.fee_bps)})`, html`${won(f.seller_net)}${f.pg_fee_bearer === 'seller' ? html`<br><span class="muted">결제 비용 ${won(f.pg_fee_amount)} 차감(추정)</span>` : ''}`, postBtn(req, `/my/products/${p.id}/options/${o.id}/toggle`, o.active ? '판매 중지' : '판매 재개', { cls: 'sm' })]; }), '옵션을 추가하세요')}
      <p class="hint">수수료는 주문 시점의 정책이 주문에 고정됩니다. 표시된 금액은 현재 정책 기준 예상치이며 환불 시 달라집니다</p>
      <form method="post" action="/my/products/${p.id}/options">${csrf(req)}<div class="row">
        ${field('옵션 이름', 'name', '', { required: true })}${field('가격(원)', 'price', '', { required: true, attrs: 'inputmode="numeric"' })}${field('기간', 'term', 'perpetual', { options: [['perpetual', '영구'], ['term', '기간제']] })}${field('기간(일)', 'term_days', '', { type: 'number' })}
        ${field('사용자 수', 'seats', '', { type: 'number' })}${field('기기 수', 'devices', '', { type: 'number' })}</div>
        ${p.type === 'license' ? check('이 옵션에 소스코드 포함', 'includes_source', false) : ''}${check('이 옵션에 설치 지원 포함', 'includes_install', false)}
        <button class="btn sm">옵션 추가</button></form>`)}
    ${card('납품 파일', html`
      <p class="sub">판매를 시작하기 전에 구매자가 실제로 받을 파일을 등록합니다. 제출한 버전은 바꿀 수 없으며, 수정하려면 새 버전을 올립니다. 기존 주문은 주문 당시 버전을 그대로 받습니다</p>
      ${notice('운영 비밀번호, 실사용 API 키, 개인정보가 담긴 DB는 넣지 마세요. 환경변수는 값이 비어 있는 예시 파일(.env.example)로 제공하세요. 업로드 시 자동 검사합니다')}
      <h3>${draft ? `작성 중인 버전 ${draft.label}` : '새 버전'}</h3>
      ${table(['파일', '종류', 'SHA-256', '검사 결과(항목별)', ''], dfiles.map((f) => { const rep = JSON.parse(f.scan_report || '{}'); return [html`${f.original_name} <span class="muted">${ui.size(f.size)}</span>${[...(rep.problems || []), ...(rep.findings || []).slice(0, 5).map((x) => `${x.label} — ${x.entry}${x.line ? `:${x.line}` : ''}`)].map((t) => html`<br><span class="badge bad">${t}</span>`)}`, ROLES[f.role], hashChip(f.sha256), V.scanCells(f), postBtn(req, `/my/products/${p.id}/version/remove`, '빼기', { cls: 'sm', fields: { file_id: f.id } })]; }), '아직 올린 파일이 없습니다')}
      <form method="post" action="/my/products/${p.id}/version/file?_csrf=${req.csrfToken}" enctype="multipart/form-data" class="row my">
        ${field('파일', 'file', '', { type: 'file', required: true })}${field('종류', 'role', '', { options: Object.entries(ROLES) })}<div class="field"><label>&nbsp;</label><button class="btn">파일 올리기</button></div></form>
      ${dfiles.length && problems.length ? notice(html`제출 전 해결할 항목: ${problems.join(' / ')}`, 'warn') : ''}
      <form method="post" action="/my/products/${p.id}/version/submit">${csrf(req)}<div class="row">${field('버전', 'label', draft?.label || '1.0.0', { required: true })}${field('변경 내용', 'notes', '')}</div><button class="btn primary">이 버전 제출(이후 변경 불가)</button></form>
      <h3>버전 이력</h3>
      ${table(['버전', '상태', '목록 지문', '제출'], versions.filter((v) => v.status !== 'draft').map((v) => [html`${v.label}${v.id === p.current_version_id ? html` ${tag('현재 판매 버전', 'ok')}` : ''}`, tag(...vStatus[v.status]), hashChip(v.manifest_hash), fmtDate(v.submitted_at)]), '제출한 버전이 없습니다')}`)}
    <h2>상품 정보 수정</h2>${productForm(req, p)}` });
}));
r.post('/my/products/:id', needSeller, h(async (req, res) => { catalog.saveProduct(req.user, int(req.params.id), req.body); res.flash('저장했습니다'); res.back(); }));
r.post('/my/products/:id/options', needSeller, h(async (req, res) => { catalog.saveOption(req.user, int(req.params.id), req.body); res.flash('옵션을 추가했습니다'); res.back(); }));
r.post('/my/products/:id/options/:oid/toggle', needSeller, h(async (req, res) => { catalog.toggleOption(req.user, int(req.params.id), int(req.params.oid)); res.back(); }));
r.post('/my/products/:id/version/file', needSeller, receiveFile('product'), h(async (req, res) => { catalog.addVersionFile(req.user, int(req.params.id), req.savedFile, req.body.role); res.flash('파일을 올렸습니다. 검사 결과를 확인하세요'); res.back(); }));
r.post('/my/products/:id/version/remove', needSeller, h(async (req, res) => { catalog.removeVersionFile(req.user, int(req.params.id), int(req.body.file_id)); res.back(); }));
r.post('/my/products/:id/version/submit', needSeller, h(async (req, res) => { catalog.submitVersion(req.user, int(req.params.id), req.body); res.flash('버전을 제출했습니다. 파일 목록이 고정되었습니다'); res.back(); }));
r.post('/my/products/:id/submit', needSeller, h(async (req, res) => { catalog.submitForReview(req.user, int(req.params.id)); res.flash('심사를 요청했습니다'); res.back(); }));
r.post('/my/products/:id/delete', needSeller, h(async (req, res) => { catalog.deleteProduct(req.user, int(req.params.id)); res.flash('판매를 종료했습니다. 기존 구매자의 납품물 접근은 유지됩니다'); res.redirect('/my/products'); }));

// ── 정산
r.get('/my/payouts', needUser, (req, res) => {
  const acct = q.get("SELECT * FROM seller_bank_accounts WHERE seller_id = ? AND status = 'active'", req.user.id);
  const pos = q.all('SELECT p.*, o.title, o.order_no FROM payouts p JOIN orders o ON o.id = p.order_id WHERE p.seller_id = ? ORDER BY p.id DESC LIMIT 200', req.user.id);
  const waiting = q.all("SELECT * FROM orders WHERE seller_id = ? AND payment_status IN ('paid','partially_refunded') AND payout_status NOT IN ('paid') ORDER BY id DESC", req.user.id);
  const ST = { created: ['수동 지급 대기', 'warn'], requested: ['지급 요청 접수(미완료)', 'warn'], unknown: ['결과 확인 중', 'warn'], paid: ['지급 완료', 'ok'], failed: ['실패', 'bad'] };
  const calc = req.query.amount ? fees.quote(Math.max(int(req.query.amount), 0), req.user.id, null) : null;
  res.page({ title: '정산', my: true, body: html`<div class="head"><h1>정산</h1></div>
    ${card('정산 계좌', html`${acct ? ui.dl([['계좌', `${acct.bank} ****${acct.account_last4} (${acct.holder})`], ['등록', fmtDate(acct.created_at)], acct.payout_hold_until && acct.payout_hold_until > new Date().toISOString() ? ['지급 보류', `계좌 변경으로 ${fmtDate(acct.payout_hold_until)}까지 보류`] : null]) : html`<p class="muted">등록된 계좌가 없습니다. 계좌가 없으면 지급되지 않습니다</p>`}
      <h3>${acct ? '계좌 변경' : '계좌 등록'}</h3>
      <p class="hint">변경하려면 비밀번호를 다시 확인하며, 변경 사실이 알림으로 남고 ${q.settingInt('bank_change_hold_hours')}시간 동안 지급이 보류됩니다</p>
      <form method="post" action="/my/payouts/account">${csrf(req)}<div class="row">${field('은행', 'bank', '', { required: true })}${field('계좌번호', 'account', '', { required: true, attrs: 'inputmode="numeric" autocomplete="off"' })}${field('예금주', 'holder', '', { required: true })}</div><button class="btn">저장</button></form>`)}
    ${card('정산 대기 주문', table(['주문', '결제액', '검수', '지급 상태'], waiting.map((o) => [html`<a href="/my/sales/${o.id}">${o.title}</a>`, won(o.amount), badge('inspection', o.inspection_status), badge('payout', o.payout_status)]), '정산 대기 주문이 없습니다'))}
    ${card('지급 내역', table(['주문', '금액', '상태', '요청', '완료'], pos.map((p) => [html`${p.title}<br><span class="muted">${p.order_no}</span>`, won(p.amount), tag(...ST[p.status]), fmtDate(p.created_at), fmtDate(p.paid_at)]), '지급 내역이 없습니다'))}
    ${card('예상 정산액 계산', html`<form method="get" class="filters"><input type="number" name="amount" value="${req.query.amount || ''}" placeholder="판매 가격(원)"><button class="btn sm">계산</button></form>
      ${calc ? ui.dl([['결제액', won(calc.amount)], ['플랫폼 수수료', `${won(calc.fee_amount)} (${bpsPct(calc.fee_bps)} · ${calc.fee_policy_label}, 부가세 ${won(calc.fee_vat)} 포함)`], ['결제 비용', `${won(calc.pg_fee_amount)} (추정 ${bpsPct(calc.pg_fee_bps)}, ${calc.pg_fee_bearer === 'seller' ? '판매자 부담' : '플랫폼 부담'})`], ['예상 지급액', won(calc.seller_net)]]) : ''}
      <p class="hint">세금 관련 항목은 참고용이며 세무 검토 전 수치입니다</p>`)}` });
});
r.post('/my/payouts/account', needSeller, h(async (req, res) => { accounts.setBankAccount(req.user, req.body); res.flash('정산 계좌를 저장했습니다'); res.back(); }));

// 후기에 대한 판매자 답변
r.post('/my/reviews/:id/reply', needSeller, h(async (req, res) => {
  const rv = q.get('SELECT * FROM reviews WHERE id = ? AND seller_id = ?', int(req.params.id), req.user.id);
  must(rv, '찾을 수 없습니다.', 404);
  q.update('reviews', rv.id, { seller_reply: str(req.body.reply, 1000) });
  res.back();
}));
module.exports = r;
