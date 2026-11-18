'use strict';
// 공개 화면: 홈, 마켓, 상품 상세, 비교, 찜, 판매자 상점, 전문가, 안전거래 안내, 고객지원
const r = require('express').Router();
const { q } = require('../db');
const { h, needUser } = require('../web');
const ui = require('../ui');
const { html, csrf, field, check, card, notice, badge, tag, won, fmtDate, table, nl2br, bullets, lines, postBtn, hashChip, bpsPct } = ui;
const { must, int, str, clock } = require('../util');
const catalog = require('../services/catalog');
const orders = require('../services/orders');
const fees = require('../services/fees');
const providers = require('../providers');
const { ROLES } = require('../services/deliveries');
const V = require('../views/order');

const TYPE = { license: '프로그램 사용권', source: '소스코드' };
const PLATFORM = { pc: 'PC 설치형', web: '웹서비스', mobile: '모바일 앱', etc: '기타' };
const VERIF = { build_check: '빌드 확인', run_check: '실행 확인', rights_docs: '권리 자료 확인' };
const cats = () => q.all('SELECT * FROM categories ORDER BY sort');

function pcard(p) {
  return html`<a class="pcard" href="/products/${p.id}">
    <div class="meta">${tag(TYPE[p.type])}${tag(PLATFORM[p.platform])}${p.category_name ? tag(p.category_name) : ''}</div>
    <h3>${p.title}</h3><p class="sub">${p.summary}</p>
    <div class="meta">${p.install_support ? tag('설치 지원') : ''}${p.customizable ? tag('커스터마이징') : ''}${p.external_paid_required ? tag('외부 유료 서비스 필요', 'warn') : ''}</div>
    <p class="muted">${p.seller_name}${p.reviews ? ` · 구매 후기 ${p.rating}점(${p.reviews}건)` : ''}</p>
    <div class="price">${won(p.min_price)}${p.min_price ? ' 부터' : ''}</div></a>`;
}

// ── 홈
r.get('/', (req, res) => {
  const recent = catalog.search({}).slice(0, 6);
  res.page({ body: html`
    <section class="hero"><div>
      <h1>소프트웨어를 사고팔 때<br>돈과 납품물이 어디에 있는지<br>끝까지 보여 드립니다</h1>
      <p class="lead">완성형 프로그램, 소스코드, 맞춤 개발, 지식재산권 거래를 조건·납품·검수·정산 기록과 함께 진행합니다</p>
      <div class="actions"><a class="btn primary" href="/market">상품 둘러보기</a><a class="btn" href="/guide">보호 범위와 한계 보기</a></div>
    </div>
    <div aria-label="주문 화면 예시">
      <div class="ledger"><div class="ledger-head"><span>주문 화면 예시</span><span>조건 지문 <code class="hash">3fa91c0b72de</code></span></div>
        <div class="ledger-cols"><div class="ledger-col"><h3>돈의 상태</h3><div class="amount">880,000원</div>
          <div class="ledger-row"><span class="sub">결제</span>${badge('payment', 'paid')}</div>
          <div class="ledger-row"><span class="sub">환불</span>${badge('refund', 'none')}</div>
          <div class="ledger-row"><span class="sub">판매자 지급</span>${badge('payout', 'not_eligible')}</div></div>
        <div class="ledger-col"><h3>납품물의 상태</h3>
          <div class="ledger-row"><span class="sub">납품</span>${badge('delivery', 'delivered')}</div>
          <div class="ledger-row"><span class="sub">검수</span>${badge('inspection', 'in_progress')}</div>
          <div class="ledger-row"><span class="sub">검수 기한</span><span>7일 남음</span></div>
          <div class="ledger-row"><span class="sub">분쟁</span>${badge('dispute', 'none')}</div></div></div>
        <div class="ledger-foot">모든 주문 화면에서 결제·대금 보호·납품·검수·분쟁·환불·지급 상태를 따로 확인할 수 있습니다</div></div>
    </div></section>
    <section class="grid g2">
      ${card('거래 유형', ui.dl([
        ['프로그램 사용권', html`설치형·웹·모바일 프로그램을 쓸 권리를 삽니다. 소스와 권리는 넘어오지 않습니다 <a href="/market?type=license">솔루션 마켓</a>`],
        ['소스코드 구매', html`소스 파일을 받고 판매자가 정한 범위에서 수정·이용합니다. 지식재산권 양도가 아닙니다 <a href="/market?type=source">소스코드 마켓</a>`],
        ['맞춤 개발', html`단계마다 결제·납품·검수를 따로 진행합니다 <a href="/requests">의뢰 보기</a>`],
        ['지식재산권 거래', html`저작재산권 양도, 독점·비독점 이용허락을 비공개 자료실과 인도 목록으로 진행합니다 <a href="/ip">권리 매물</a>`],
      ]))}
      ${card('분야', html`<div class="cats">${cats().map((c) => html`<a href="/market?category=${c.slug}">${c.name}</a>`)}</div>`)}
    </section>
    <div class="head"><h2>최근 등록 상품</h2><a href="/market">전체 보기</a></div>
    ${recent.length ? html`<div class="pgrid">${recent.map(pcard)}</div>` : html`<p class="empty">아직 판매 중인 상품이 없습니다. <a href="/my/seller">판매자로 등록</a>하고 첫 상품을 올려 보세요</p>`}` });
});

// ── 마켓 목록·검색
r.get('/market', (req, res) => {
  const f = req.query;
  const list = catalog.search(f);
  const sel = (name, opts, cur) => html`<select name="${name}" aria-label="${name}">${opts.map(([v, l]) => html`<option value="${v}" ${String(cur || '') === String(v) ? ui.raw('selected') : ''}>${l}</option>`)}</select>`;
  res.page({ title: f.type ? TYPE[f.type] + ' 마켓' : '마켓', body: html`
    <div class="head"><div><h1>${f.type === 'source' ? '소스코드 마켓' : f.type === 'license' ? '솔루션 마켓' : '전체 상품'}</h1>
      <p class="sub">${f.type === 'source' ? '소스 파일을 받아 판매자가 정한 범위에서 이용합니다. 권리 양도는 지식재산권 거래에서 다룹니다' : '상품마다 제공물, 권리, 검수 기준을 확인하세요'}</p></div><a class="btn sm" href="/compare">비교함</a></div>
    <form class="filters" method="get" action="/market">
      <input type="search" name="q" value="${f.q || ''}" placeholder="검색어">
      ${sel('type', [['', '전체 유형'], ['license', '사용권'], ['source', '소스코드']], f.type)}
      ${sel('category', [['', '전체 분야'], ...cats().map((c) => [c.slug, c.name])], f.category)}
      ${sel('platform', [['', '사용 환경'], ...Object.entries(PLATFORM)], f.platform)}
      <input type="number" name="min" value="${f.min || ''}" placeholder="최소 가격"><input type="number" name="max" value="${f.max || ''}" placeholder="최대 가격">
      ${sel('verified', [['', '검증 범위'], ...Object.entries(VERIF)], f.verified)}
      ${sel('rating', [['', '구매자 평가'], [4, '4점 이상'], [3, '3점 이상']], f.rating)}
      ${sel('sort', [['new', '최신순'], ['price', '낮은 가격순'], ['rating', '평가순']], f.sort)}
      ${check('소스 제공', 'source', f.source)}${check('설치 지원', 'install', f.install)}${check('커스터마이징', 'custom', f.custom)}${check('외부 유료 서비스 불필요', 'noext', f.noext)}
      <button class="btn sm">적용</button></form>
    ${list.length ? html`<div class="pgrid">${list.map(pcard)}</div>` : html`<p class="empty">조건에 맞는 상품이 없습니다</p>`}` });
});

// ── 상품 상세
r.get('/products/:id', h(async (req, res) => {
  const p = q.get(`SELECT p.*, c.name AS category_name, sp.display_name AS seller_name, sp.status AS seller_status FROM products p
    JOIN seller_profiles sp ON sp.user_id = p.seller_id LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`, req.params.id);
  const mine = p && req.user && (p.seller_id === req.user.id || req.user.staff.length);
  must(p && (p.status === 'approved' || mine) && p.status !== 'deleted', '상품을 찾을 수 없습니다.', 404);
  const opts = q.all('SELECT * FROM product_options WHERE product_id = ? AND active = 1 ORDER BY price', p.id);
  const ver = p.current_version_id ? q.get('SELECT * FROM product_versions WHERE id = ?', p.current_version_id) : null;
  const files = ver ? orders.versionFiles(ver.id) : [];
  const verifs = q.all('SELECT * FROM product_verifications WHERE product_id = ? ORDER BY id DESC', p.id);
  const reviews = q.all('SELECT r.*, u.name FROM reviews r JOIN users u ON u.id = r.buyer_id WHERE r.product_id = ? AND r.hidden = 0 ORDER BY r.id DESC LIMIT 30', p.id);
  const sched = orders.scheduleCheck(0, p.inspection_days);
  const caps = sched.caps;
  const fav = req.user && q.get('SELECT 1 FROM favorites WHERE user_id = ? AND product_id = ?', req.user.id, p.id);
  const companies = req.user ? q.all("SELECT c.id, c.name, m.role, c.require_approval FROM company_members m JOIN companies c ON c.id = m.company_id WHERE m.user_id = ? AND m.role IN ('admin','buyer')", req.user.id) : [];
  const sellsSource = p.type === 'source' || opts.some((o) => o.includes_source);
  const buyable = p.status === 'approved' && !p.sales_blocked && p.seller_status === 'approved' && ver && opts.length && sched.ok;
  const threshold = q.settingInt('high_value_threshold');
  const shots = lines(p.screenshots).filter((u) => /^https:\/\//.test(u));
  res.page({ title: p.title, body: html`
    ${p.status !== 'approved' ? notice(html`공개 전 미리보기입니다 — 상태: ${ui.label('product', p.status)}`, 'warn') : ''}
    ${p.sales_blocked ? notice('운영 정책에 따라 신규 판매가 제한된 상품입니다', 'bad') : ''}
    <div class="head"><div><div class="actions">${tag(TYPE[p.type])}${tag(PLATFORM[p.platform])}${p.category_name ? tag(p.category_name) : ''}</div>
      <h1>${p.title}</h1><p class="sub">${p.summary}</p><p class="muted">판매자 <a href="/sellers/${p.seller_id}">${p.seller_name}</a></p></div></div>
    <div class="split"><div>
      ${card('무엇을 받는가', html`${ui.dl([
        ['제공 파일', files.length ? html`<ul class="list">${files.filter((f) => f.role !== 'source' || sellsSource).map((f) => html`<li>${ROLES[f.role]} — ${f.original_name} <span class="muted">${ui.size(f.size)}</span> ${hashChip(f.sha256, 10)}</li>`)}</ul><p class="hint">판매 시작 전 플랫폼 비공개 저장소에 등록된 실제 납품 파일입니다(버전 ${ver.label}). 주문하면 이 버전과 해시가 주문에 고정됩니다</p>` : '등록된 납품 파일 없음'],
        ['소스코드', sellsSource ? (p.type === 'source' ? '포함' : '소스 포함 옵션 선택 시 포함') : '미포함(실행 파일·이용권만 제공)'],
        ['포함 범위', bullets(p.included)], ['제외 범위', bullets(p.excluded)],
        ['언제 받는가', '결제 상태를 서버가 확인하는 즉시 다운로드할 수 있습니다. 구매확정은 파일을 받은 뒤에 합니다'],
      ])}`)}
      ${card('어떤 권리를 받는가', html`${ui.dl([
        ['거래 유형', sellsSource ? '소스코드 인도 + 이용허락' : '프로그램 사용권'],
        ['허용 범위', html`<div class="actions">${V.LIC({ modify: p.lic_modify, commercial: p.lic_commercial, redistribute: p.lic_redistribute, resale: p.lic_resale }).map(([k, v]) => tag(`${k} ${v ? '허용' : '불가'}`, v ? 'ok' : ''))}</div>`],
        ['지식재산권', html`양도되지 않습니다. 소스 파일을 받아도 저작권 등 권리는 판매자에게 남습니다. 권리 양도가 필요하면 <a href="/ip">지식재산권 거래</a>를 이용하세요`],
        p.license_notes ? ['라이선스 조건', nl2br(p.license_notes)] : null,
        ['제3자 라이선스', p.third_party_licenses ? nl2br(p.third_party_licenses) : '판매자 기재 없음'],
        ['업데이트·지원', p.update_support ? nl2br(p.update_support) : '판매자 기재 없음'],
      ])}`)}
      ${card('해결하는 문제와 기능', html`${p.problem ? html`<p>${nl2br(p.problem)}</p>` : ''}${p.description ? html`<p>${nl2br(p.description)}</p>` : ''}<h3>기능</h3>${bullets(p.features)}
        ${shots.length ? html`<h3>실제 화면</h3><div class="shots">${shots.map((u) => html`<img src="${u}" alt="상품 화면" loading="lazy">`)}</div>` : ''}
        <div class="actions mt">${p.demo_url ? html`<a class="btn sm" href="${p.demo_url}" rel="noopener nofollow" target="_blank">체험 링크</a>` : ''}${p.video_url ? html`<a class="btn sm" href="${p.video_url}" rel="noopener nofollow" target="_blank">영상</a>` : ''}</div>`)}
      ${card('사용 환경과 추가 비용', ui.dl([
        ['지원 환경', nl2br(p.environments)], ['설치·배포 방법', p.install_method ? nl2br(p.install_method) : '판매자 기재 없음'],
        ['설치 지원', p.install_support ? html`옵션에 따라 제공 — 완료 조건: ${p.install_done_criteria || '판매자와 협의'}` : '없음'],
        ['커스터마이징', p.customizable ? html`가능 — <a href="/requests/new?product=${p.id}">추가 개발 요청</a>` : '제공하지 않음'],
        ['추가 비용', p.external_paid_required ? html`${tag('외부 유료 서비스 필요', 'warn')}<br>${nl2br(p.external_costs)}` : '판매자가 고지한 외부 API·서버·구독 비용 없음'],
      ]))}
      ${card('검수와 문제 해결', ui.dl([
        ['검수 기간', `납품물 접근이 가능해진 시점부터 ${p.inspection_days}일`], ['검수 기준', nl2br(p.inspection_criteria)],
        ['환불·분쟁 절차', nl2br(p.refund_policy)],
        ['문제가 생기면', '주문 화면의 "문제 제기"에서 접수합니다. 분쟁 중에는 판매자 정산이 가능한 범위에서 보류됩니다'],
      ]))}
      ${card('확인 범위', html`<p class="sub">아래 항목은 서로 별개의 확인이며 어느 하나도 전체 품질이나 권리를 보증하지 않습니다</p>
        ${table(['항목', '결과', '범위'], [
          ...files.map((f) => [`파일 검사 — ${f.original_name}`, V.scanCells(f), '업로드 시 자동 검사(코드를 실행하지 않음)']),
          ...verifs.map((v) => [VERIF[v.kind], tag(v.result === 'passed' ? '확인됨' : '문제 있음', v.result === 'passed' ? 'ok' : 'bad'), html`${v.scope_note} <span class="muted">${fmtDate(v.created_at, false)}</span>`]),
        ], '기록된 확인 항목이 없습니다')}
        ${verifs.length ? '' : html`<p class="hint">운영자의 빌드 확인·실행 확인·권리 자료 확인 기록이 없는 상품입니다</p>`}`)}
      ${card(`구매 후기 ${reviews.length}건`, reviews.length ? reviews.map((v) => html`<div class="card flat"><p>${tag(`${v.rating}점`)} <span class="muted">${v.name.slice(0, 1)}** · ${fmtDate(v.created_at, false)} · 검수를 마친 구매자</span></p><p>${nl2br(v.body)}</p>${v.seller_reply ? html`<p class="sub">판매자 답변: ${nl2br(v.seller_reply)}</p>` : ''}</div>`) : html`<p class="muted">아직 후기가 없습니다. 후기는 검수를 마친 실제 구매자만 남길 수 있습니다</p>`)}
    </div>
    <aside class="sticky">
      ${card('구매', html`${opts.length ? html`<form method="post" action="/orders">${csrf(req)}<input type="hidden" name="product_id" value="${p.id}">
        ${opts.map((o, i) => html`<label class="check"><input type="radio" name="option_id" value="${o.id}" ${i === 0 ? ui.raw('checked') : ''}><span><b>${won(o.price)}</b> ${o.name}<br><span class="muted">${o.term === 'term' ? `기간제 ${o.term_days}일` : '영구'}${o.seats ? ` · 사용자 ${o.seats}명` : ''}${o.devices ? ` · 기기 ${o.devices}대` : ''}${o.includes_source ? ' · 소스 포함' : ''}${o.includes_install ? ' · 설치 지원 포함' : ''}</span></span></label>`)}
        ${companies.length ? field('구매 주체', 'company_id', '', { options: [['', '개인'], ...companies.map((c) => [c.id, `${c.name}${c.require_approval && c.role !== 'admin' ? ' (관리자 승인 필요)' : ''}`])], hint: html`승인이 필요하면 <a href="/my/company">기업 계정</a>에서 구매 승인을 먼저 요청하세요` }) : ''}
        ${opts.some((o) => o.price >= threshold) ? check(`고액 거래 별도 확인 절차 선택(${won(threshold)} 이상 — 운영자 확인 후 정산)`, 'extra_verification', false) : ''}
        ${check('제공물, 권리 범위, 추가 비용, 검수 기준과 기간을 확인했고 이 조건으로 주문합니다', 'agreed', false, { required: true })}
        ${notice(orders.protectionNotice(caps), caps.mode === 'test' ? 'warn' : '')}
        ${buyable ? html`<button class="btn primary block">주문하고 조건 확인</button>` : notice(!sched.ok ? sched.problems.join(' ') : '지금은 구매할 수 없는 상품입니다', 'bad')}
        </form>` : html`<p class="muted">판매 옵션이 없습니다</p>`}
        <div class="actions mt">${req.user ? postBtn(req, `/favorites/${p.id}`, fav ? '찜 해제' : '찜하기', { cls: 'sm' }) : ''}${postBtn(req, '/compare/add', '비교함에 담기', { cls: 'sm', fields: { id: p.id } })}</div>`)}
      ${card('구매 전 문의', req.user ? (req.user.id === p.seller_id ? html`<p class="muted">내 상품입니다</p>` : html`<form method="post" action="/inquiry">${csrf(req)}<input type="hidden" name="product_id" value="${p.id}">${field('문의 내용', 'body', '', { rows: 3, required: true })}<button class="btn sm">판매자에게 문의</button></form>`) : html`<p class="muted"><a href="/login?next=/products/${p.id}">로그인</a> 후 문의할 수 있습니다</p>`)}
      ${req.user ? card('신고', html`<form method="post" action="/report">${csrf(req)}<input type="hidden" name="target_type" value="product"><input type="hidden" name="target_id" value="${p.id}">
        ${field('유형', 'kind', '', { options: [['rights_infringement', '권리 침해 의심'], ['malware', '악성 파일 의심'], ['fraud', '허위 설명'], ['other', '기타']] })}${field('내용', 'body', '', { rows: 2, required: true })}<button class="btn sm">신고 접수</button></form>`) : ''}
    </aside></div>` });
}));

// ── 찜 · 비교
r.post('/favorites/:id', needUser, (req, res) => {
  const has = q.get('SELECT 1 FROM favorites WHERE user_id = ? AND product_id = ?', req.user.id, int(req.params.id));
  if (has) q.run('DELETE FROM favorites WHERE user_id = ? AND product_id = ?', req.user.id, int(req.params.id));
  else if (q.get("SELECT 1 FROM products WHERE id = ? AND status = 'approved'", int(req.params.id))) q.run('INSERT INTO favorites VALUES (?,?,?)', req.user.id, int(req.params.id), clock.iso());
  res.back();
});
r.get('/my/favorites', needUser, (req, res) => {
  const ids = q.all('SELECT product_id FROM favorites WHERE user_id = ?', req.user.id).map((x) => x.product_id);
  const list = catalog.search({}).filter((p) => ids.includes(p.id));
  res.page({ title: '찜한 상품', my: true, body: html`<div class="head"><h1>찜한 상품</h1></div>${list.length ? html`<div class="pgrid">${list.map(pcard)}</div>` : html`<p class="empty">찜한 상품이 없습니다</p>`}` });
});
const cmpIds = (req) => String(req.cookies.eum_cmp || '').split(',').map(Number).filter(Boolean).slice(0, 4);
r.post('/compare/add', (req, res) => { const ids = [...new Set([...cmpIds(req), int(req.body.id)])].slice(-4); res.cookie('eum_cmp', ids.join(','), { httpOnly: true, sameSite: 'lax', path: '/' }); res.flash('비교함에 담았습니다'); res.back(); });
r.post('/compare/remove', (req, res) => { res.cookie('eum_cmp', cmpIds(req).filter((i) => i !== int(req.body.id)).join(','), { httpOnly: true, sameSite: 'lax', path: '/' }); res.back(); });
r.get('/compare', (req, res) => {
  const ids = cmpIds(req);
  const ps = catalog.search({}).filter((p) => ids.includes(p.id));
  const yn = (v) => (v ? '예' : '아니오');
  const rows = [
    ['유형', (p) => TYPE[p.type]], ['가격', (p) => `${won(p.min_price)} 부터`], ['사용 환경', (p) => PLATFORM[p.platform]], ['지원 환경', (p) => p.environments],
    ['소스 제공', (p) => yn(p.type === 'source' || q.get('SELECT 1 FROM product_options WHERE product_id = ? AND active = 1 AND includes_source = 1', p.id))],
    ['수정 / 상업적 이용', (p) => `${yn(p.lic_modify)} / ${yn(p.lic_commercial)}`], ['재배포 / 재판매', (p) => `${yn(p.lic_redistribute)} / ${yn(p.lic_resale)}`],
    ['설치 지원', (p) => yn(p.install_support)], ['커스터마이징', (p) => yn(p.customizable)], ['외부 유료 서비스', (p) => (p.external_paid_required ? `필요 — ${p.external_costs}` : '고지 없음')],
    ['검수 기간', (p) => `${p.inspection_days}일`], ['구매 후기', (p) => (p.reviews ? `${p.rating}점 (${p.reviews}건)` : '없음')], ['판매자', (p) => p.seller_name],
    ['', (p) => postBtn(req, '/compare/remove', '빼기', { cls: 'sm', fields: { id: p.id } })],
  ];
  res.page({ title: '상품 비교', body: html`<div class="head"><h1>상품 비교</h1></div>${ps.length ? html`<div class="table-wrap"><table class="compare"><thead><tr><th></th>${ps.map((p) => html`<th><a href="/products/${p.id}">${p.title}</a></th>`)}</tr></thead>
    <tbody>${rows.map(([l, fn]) => html`<tr><td>${l}</td>${ps.map((p) => html`<td>${fn(p)}</td>`)}</tr>`)}</tbody></table></div>` : html`<p class="empty">상품 상세에서 "비교함에 담기"를 눌러 최대 4개까지 비교할 수 있습니다</p>`}` });
});

// ── 판매자 상점 · 전문가 찾기
r.get('/sellers/:id', (req, res, next) => {
  const s = q.get("SELECT sp.*, u.status AS user_status FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.user_id = ? AND sp.status = 'approved'", req.params.id);
  if (!s) return next();
  const ps = catalog.search({ seller: s.user_id });
  const stats = q.get("SELECT COUNT(*) c FROM orders WHERE seller_id = ? AND inspection_status IN ('approved','auto_approved','closed_by_admin')", s.user_id);
  const reviews = q.all('SELECT r.*, u.name FROM reviews r JOIN users u ON u.id = r.buyer_id WHERE r.seller_id = ? AND r.hidden = 0 ORDER BY r.id DESC LIMIT 20', s.user_id);
  res.page({ title: s.display_name, body: html`<div class="head"><div><h1>${s.display_name}</h1><p class="sub">${{ individual: '개인', sole: '개인사업자', corp: '법인' }[s.biz_type]} · 가입 ${fmtDate(s.created_at, false)} · 검수 완료 거래 ${stats.c}건</p></div>
      ${req.user && req.user.id !== s.user_id ? html`<a class="btn sm" href="/requests/new?seller=${s.user_id}">개발 의뢰하기</a>` : ''}</div>
    ${s.user_status !== 'active' ? notice('현재 활동하지 않는 판매자입니다. 기존 구매자의 납품물 접근은 보관 정책에 따라 유지됩니다', 'warn') : ''}
    <div class="grid g2">${card('소개', html`<p>${nl2br(s.intro) || '소개 없음'}</p>${s.skills ? html`<div class="actions">${s.skills.split(',').map((k) => tag(k.trim()))}</div>` : ''}`)}${card('포트폴리오', bullets(s.portfolio))}</div>
    <h2>판매 상품</h2>${ps.length ? html`<div class="pgrid">${ps.map(pcard)}</div>` : html`<p class="empty">판매 중인 상품이 없습니다</p>`}
    ${card(`구매 후기 ${reviews.length}건`, reviews.length ? reviews.map((v) => html`<p>${tag(`${v.rating}점`)} ${v.body} <span class="muted">${fmtDate(v.created_at, false)}</span></p>`) : html`<p class="muted">후기 없음</p>`)}` });
});
r.get('/experts', (req, res) => {
  const k = str(req.query.q, 60);
  const list = q.all(`SELECT sp.*, (SELECT COUNT(*) FROM products p WHERE p.seller_id = sp.user_id AND p.status = 'approved') AS products,
      (SELECT COUNT(*) FROM orders o WHERE o.seller_id = sp.user_id AND o.inspection_status IN ('approved','auto_approved','closed_by_admin')) AS done,
      (SELECT ROUND(AVG(rating),1) FROM reviews r WHERE r.seller_id = sp.user_id AND r.hidden = 0) AS rating
    FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.status = 'approved' AND u.status = 'active' AND (? = '' OR sp.skills LIKE ? OR sp.display_name LIKE ? OR sp.intro LIKE ?) ORDER BY done DESC, sp.created_at LIMIT 100`, k, `%${k}%`, `%${k}%`, `%${k}%`);
  res.page({ title: '전문가 찾기', body: html`<div class="head"><div><h1>전문가 찾기</h1><p class="sub">심사를 통과한 판매자입니다. 심사는 등록 정보 확인이며 작업 품질을 보증하지 않습니다</p></div></div>
    <form class="filters" method="get"><input type="search" name="q" value="${k}" placeholder="기술, 분야"><button class="btn sm">검색</button></form>
    ${table(['판매자', '기술', '판매 상품', '검수 완료 거래', '후기 평점'], list.map((s) => [html`<a href="/sellers/${s.user_id}">${s.display_name}</a>`, s.skills, s.products, s.done, s.rating ?? '-']), '조건에 맞는 판매자가 없습니다')}` });
});

// ── 안전거래 안내: 실제 보호 범위와 한계
r.get('/guide', (req, res) => {
  const c = providers.caps();
  const yn = (v, t = '지원(확인됨)', f = '미지원 또는 미확인') => (v ? (c.mode === 'test' ? tag('시뮬레이션', 'warn') : tag(t, 'ok')) : tag(f, 'warn'));
  res.page({ title: '안전거래 안내', body: html`<div class="head"><div><h1>안전거래 안내</h1><p class="sub">이음마켓이 실제로 하는 일과 하지 못하는 일을 구분해 안내합니다</p></div></div>
    ${c.mode === 'test' ? notice('현재 이 사이트는 테스트 결제 환경입니다. 실제 돈이 이동하지 않으며 결제대금 보호도 적용되지 않습니다', 'warn') : ''}
    ${card('세 가지는 서로 다른 장치입니다', table(['구분', '누가 하는가', '하는 일', '하지 못하는 일'], [
      ['결제대금 보호', '결제 사업자', '결제 사업자가 지원하고 확인된 범위에서 대금을 보류합니다. 주문 화면에 사업자가 응답한 실제 상태를 표시합니다', '플랫폼 내부의 "정산 보류" 표시는 대금 보호가 아닙니다. 사업자가 보류를 지원하지 않는 결제에는 보호가 적용되지 않습니다'],
      ['납품물 보관', '이음마켓', '판매자의 납품 파일을 암호화된 비공개 저장소에 보관하고, 결제가 확인된 주문에만 접근 권한을 줍니다. 주문 시점의 파일 버전과 해시를 고정합니다', '전문 소스코드 에스크로(제3자 임치) 계약과 같은 서비스가 아닙니다. 파일 해시는 같은 파일인지 확인할 뿐 기능이나 판매 권한을 증명하지 않습니다'],
      ['검수 후 정산', '이음마켓 + 결제 사업자', '납품·검수·분쟁·환불 상태와 사업자의 지급 가능 상태를 확인한 뒤 판매자 지급을 요청합니다', '이미 판매자에게 지급된 금액은 일반 절차로 되돌릴 수 없으며 별도의 사후 환불·회수 검토로 진행합니다'],
    ]))}
    ${card(`현재 결제 사업자 기능 (${c.provider}${c.mode === 'test' ? ' · 테스트' : ''})`, html`${ui.dl([
      ['대금 보류', c.mode === 'test' ? tag('시뮬레이션 — 실제 보호 없음', 'warn') : yn(c.escrow_hold)], ['최대 보류 기간', c.max_hold_days ? `${c.max_hold_days}일${c.mode === 'test' ? ' (시뮬레이션)' : ''}` : '확인되지 않음'],
      ['분쟁 시 지급 중지', yn(c.dispute_hold)], ['부분 환불 가능 결제수단', ((c.partial_refund_methods || []).join(', ') || '확인되지 않음 — 수동 절차') + (c.mode === 'test' ? ' (시뮬레이션)' : '')],
      ['단계별 결제', yn(c.staged_payments)], ['판매자 지급 방식', c.mode === 'test' ? '시뮬레이션 — 실제 지급 없음' : c.payout_api ? '사업자 지급 API' : '수동 지급(운영자 이체 후 증빙 기록)'],
    ])}<p class="hint">운영자가 계약·문서로 확인한 기능만 켜집니다. 납품 기한과 검수 기간이 사업자의 보류 기간 안에 들어오지 않는 상품은 결제가 막힙니다</p>`)}
    <div class="grid g2">
      ${card('구매자', html`<ol class="steps"><li>상품의 제공물, 권리 범위, 추가 비용, 검수 기준을 확인합니다</li><li>결제하면 서버가 결제 사업자에 결제 상태를 확인합니다</li><li>확인 즉시 주문 전용 다운로드 권한이 생깁니다. 구매확정을 먼저 누를 필요가 없습니다</li><li>검수 기간 안에 구매확정 또는 문제 제기를 합니다. 다운로드만으로 검수가 끝나지 않습니다</li><li>문제 제기 시 분쟁 절차로 전환되고 정산이 가능한 범위에서 보류됩니다</li></ol>`)}
      ${card('판매자', html`<ol class="steps"><li>판매 전에 실제 납품 파일을 등록합니다. 제출한 버전은 바꿀 수 없고 새 버전으로만 갱신됩니다</li><li>구매자가 동의한 조건, 다운로드 기록, 요청과 답변이 모두 남습니다</li><li>계약 밖 요청은 범위 외로 분류하고 추가 개발 견적으로 안내할 수 있습니다</li><li>검수 기한이 지나도 응답이 없으면 검수 종료 심사를 요청할 수 있습니다</li><li>검수·분쟁·환불 상태 확인 후 수수료를 뺀 금액이 지급됩니다</li></ol>`)}
    </div>
    ${card('알아 두어야 할 한계', html`<ul class="list">
      <li>환불이 완료되면 추가 다운로드는 차단되지만, 이미 내려받은 소스는 플랫폼이 원격으로 삭제하거나 회수할 수 없습니다. 구매자에게 이용 종료와 삭제 확인을 요청합니다</li>
      <li>플랫폼은 구매자 시스템에 접속하거나 프로그램을 원격으로 비활성화하지 않습니다</li>
      <li>악성 파일 검사, 비밀값·개인정보 노출 검사, 압축 구조 검사는 각각 별개이며 "검사 불가"는 검사하지 못했다는 뜻입니다. 업로드된 코드를 실행해 보지는 않습니다</li>
      <li>운영자의 빌드 확인·실행 확인·권리 자료 확인은 기록된 범위에 한한 확인이며 품질이나 권리를 보증하지 않습니다</li>
      <li>소스 파일을 받는 것과 지식재산권을 양도받는 것은 다릅니다. 권리 양도는 지식재산권 거래 절차로만 진행합니다</li>
      <li>분쟁은 양측 합의 또는 운영자(사람)의 결정으로 처리합니다. 결과에 동의하지 않으면 이의제기와 외부 분쟁조정 절차를 이용할 수 있습니다</li>
      <li>플랫폼이 제공하는 계약서 양식은 법률 검토 전 초안입니다</li></ul>`)}` });
});

// ── 고객지원
r.get('/support', (req, res) => {
  const mine = req.user ? q.all('SELECT * FROM tickets WHERE user_id = ? ORDER BY id DESC LIMIT 50', req.user.id) : [];
  res.page({ title: '고객지원', body: html`<div class="head"><div><h1>고객지원</h1><p class="sub">거래 중 문제는 주문 화면의 문제 제기를 이용하면 정산 보류와 함께 처리됩니다</p></div></div>
    <div class="split"><div>${card('자주 묻는 질문', ui.dl([
      ['결제했는데 파일이 안 보여요', '결제 사업자의 확인이 끝나야 접근 권한이 생깁니다. 주문 화면에서 "지금 다시 확인"을 눌러 보세요. 파일 접근 문제로 표시되면 복구될 때까지 검수 기간이 시작되지 않습니다'],
      ['환불은 어떻게 하나요', '주문 화면에서 문제 제기와 함께 환불을 요청합니다. 판매자와의 합의 또는 운영자 결정 후 실제 결제 취소가 확인되면 완료됩니다'],
      ['구매자가 검수를 미뤄요', '검수 기한이 지나면 판매 주문 화면에서 검수 종료 심사를 요청할 수 있습니다'],
      ['정산은 언제 되나요', '검수 완료, 분쟁·환불 없음, 판매자 계좌 확인 등 조건이 충족되면 정산 주기에 맞춰 지급 요청됩니다. 판매 주문 화면에서 남은 조건을 볼 수 있습니다'],
    ]))}
    ${req.user ? card('내 문의', table(['제목', '상태', '최근'], mine.map((t) => [html`<a href="/support/tickets/${t.id}">${t.subject}</a>`, { open: '접수', answered: '답변 완료', closed: '종료' }[t.status], fmtDate(t.updated_at)]), '문의 내역이 없습니다')) : ''}</div>
    <aside>${card('문의하기', req.user ? html`<form method="post" action="/support/tickets">${csrf(req)}
      ${field('분류', 'category', '', { options: [['general', '일반'], ['payment', '결제·환불'], ['delivery', '납품·다운로드'], ['settlement', '정산'], ['maintenance', '유지보수·설치 대행'], ['account', '계정']] })}
      ${field('관련 주문번호(선택)', 'order_no', '')}${field('제목', 'subject', '', { required: true })}${field('내용', 'body', '', { rows: 5, required: true })}<button class="btn primary">문의 접수</button></form>` : html`<p class="muted"><a href="/login?next=/support">로그인</a> 후 문의할 수 있습니다</p>`)}</aside></div>` });
});
r.post('/support/tickets', needUser, h(async (req, res) => {
  must(str(req.body.subject).length >= 2 && str(req.body.body).length >= 5, '제목과 내용을 입력하세요.');
  const o = req.body.order_no ? q.get('SELECT id FROM orders WHERE order_no = ? AND (buyer_id = ? OR seller_id = ?)', str(req.body.order_no, 40), req.user.id, req.user.id) : null;
  const id = q.insert('tickets', { user_id: req.user.id, order_id: o?.id ?? null, category: str(req.body.category, 20) || 'general', subject: str(req.body.subject, 200), created_at: clock.iso(), updated_at: clock.iso() });
  q.insert('ticket_messages', { ticket_id: id, user_id: req.user.id, body: str(req.body.body), created_at: clock.iso() });
  require('../log').notifyStaff('support', '새 지원 티켓', str(req.body.subject, 100), `/admin/tickets/${id}`);
  res.redirect(`/support/tickets/${id}`);
}));
r.get('/support/tickets/:id', needUser, (req, res, next) => {
  const t = q.get('SELECT * FROM tickets WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  if (!t) return next();
  const ms = q.all('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id', t.id);
  res.page({ title: t.subject, body: html`<div class="head"><div><h1>${t.subject}</h1><p class="sub">${{ open: '접수', answered: '답변 완료', closed: '종료' }[t.status]} · ${fmtDate(t.created_at)}</p></div></div>
    <div class="thread">${ms.map((m) => html`<div class="msg ${m.is_staff ? '' : 'me'}"><div class="who">${m.is_staff ? '고객지원' : '나'} · ${fmtDate(m.created_at)}</div>${nl2br(m.body)}</div>`)}</div>
    ${t.status !== 'closed' ? html`<form method="post" action="/support/tickets/${t.id}">${csrf(req)}${field('추가 내용', 'body', '', { rows: 3, required: true })}<button class="btn">보내기</button></form>` : ''}` });
});
r.post('/support/tickets/:id', needUser, h(async (req, res) => {
  const t = q.get("SELECT * FROM tickets WHERE id = ? AND user_id = ? AND status <> 'closed'", req.params.id, req.user.id);
  must(t && str(req.body.body).length >= 1, '보낼 수 없습니다.', 404);
  q.insert('ticket_messages', { ticket_id: t.id, user_id: req.user.id, body: str(req.body.body), created_at: clock.iso() });
  q.update('tickets', t.id, { status: 'open', updated_at: clock.iso() });
  res.back();
}));

module.exports = r;
module.exports.pcard = pcard;
