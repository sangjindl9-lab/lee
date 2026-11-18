'use strict';
// 운영자 화면. 권한: review(심사) support(고객지원) settlement(정산) super(최고관리자)
const r = require('express').Router();
const { q } = require('../db');
const { h, needStaff } = require('../web');
const ui = require('../ui');
const { html, csrf, field, check, card, notice, badge, tag, won, fmtDate, table, postBtn, nl2br, hashChip, dl, bpsPct } = ui;
const { clock, must, int, str, toWon, AppError, notFound } = require('../util');
const { audit, notify } = require('../log');
const providers = require('../providers');
const storage = require('../storage');
const accounts = require('../services/accounts');
const catalog = require('../services/catalog');
const orders = require('../services/orders');
const access = require('../services/access');
const inspection = require('../services/inspection');
const disputes = require('../services/disputes');
const refunds = require('../services/refunds');
const settlement = require('../services/settlement');
const reconcile = require('../services/reconcile');
const fees = require('../services/fees');
const jobs = require('../services/jobs');
const adminSvc = require('../services/admin');
const { ROLES } = require('../services/deliveries');
const V = require('../views/order');
const nav = require('../views/adminnav');

const anyStaff = needStaff('review', 'support', 'settlement');
const page = (req, res, title, body) => res.page({ title: `운영 · ${title}`, admin: true, adminNav: nav.forUser(req.user), body });
const has = (u, ...roles) => u.staff.includes('super') || roles.some((x) => u.staff.includes(x));
const userName = (id) => (id ? q.get('SELECT name FROM users WHERE id = ?', id)?.name || `#${id}` : '-');
const head = (title, sub, right) => html`<div class="head"><div><h1>${title}</h1>${sub ? html`<p class="sub">${sub}</p>` : ''}</div>${right || ''}</div>`;
const STAFF_ROLES = { review: '심사', support: '고객지원', settlement: '정산', super: '최고관리자' };

// ── 현황
r.get('/admin', anyStaff, (req, res) => {
  const queues = adminSvc.queues().filter(([, , , roles]) => has(req.user, ...roles));
  const statCard = (mode, title, note) => {
    const s = adminSvc.stats(mode);
    return card(title, html`${note ? notice(note, 'warn') : ''}${dl([
      ['결제 확인 주문', `${s.orders}건`], ['총 거래액', html`<b>${won(s.gmv)}</b> <span class="muted">결제 확인 금액 합계</span>`],
      ['플랫폼 수수료 수익', html`<b>${won(s.fee)}</b> <span class="muted">원장 기준, 환불분 차감 후. 총 거래액과 다른 수치입니다</span>`],
      ['환불액', won(s.refunded)], ['판매자 지급 완료', won(s.paidOut)], ['지급 요청 중(미완료)', won(s.inTransit)], ['지급 대기(정산 전)', won(s.payable)],
    ])}`);
  };
  page(req, res, '현황', html`${head('현황', `결제 사업자: ${providers.active().name} (${providers.active().mode === 'test' ? '테스트' : '실결제'})`)}
    ${card('처리 대기', table(['항목', '건수', ''], queues.map(([l, n, href]) => [l, n ? html`<b>${n}</b>` : html`<span class="muted">0</span>`, html`<a href="${href}">열기</a>`])))}
    <div class="grid g2">${statCard('live', '거래 통계 — 실결제')}${statCard('test', '거래 통계 — 테스트 결제', '테스트 결제 수치입니다. 실제 돈이 이동하지 않았으며 실결제 통계에 포함되지 않습니다')}</div>
    ${has(req.user, 'settlement') ? card('주기 작업', html`<p class="sub">접근 복구, 검수 기한 알림, 환불·지급 결과 확인, 정산 요청, 대사를 한 번 실행합니다. 평소에는 5분마다 자동 실행됩니다</p>${postBtn(req, '/admin/jobs/run', '지금 한 번 실행')}`) : ''}`);
});
r.post('/admin/jobs/run', needStaff('settlement'), h(async (req, res) => {
  const out = await jobs.runAll();
  audit(req.user, 'jobs.run', '', '', out, req.ip);
  res.flash('주기 작업 실행 결과: ' + Object.entries(out).map(([k, v]) => `${k}=${v ?? '완료'}`).join(', ')); res.back('/admin');
}));

// 운영자 파일 다운로드(사용 시 감사 기록)
r.post('/admin/files/:fid/link', needStaff('review', 'support'), h(async (req, res) => {
  const f = q.get('SELECT id FROM files WHERE id = ?', int(req.params.fid));
  if (!f) throw notFound();
  res.redirect(303, '/dl/' + access.issue(req.user, { fileId: f.id, context: 'admin' }, req));
}));

// ── 판매자 심사
r.get('/admin/sellers', needStaff('review'), (req, res) => {
  const rows = q.all("SELECT s.*, u.email, u.name, u.status AS user_status FROM seller_profiles s JOIN users u ON u.id = s.user_id ORDER BY CASE s.status WHEN 'pending' THEN 0 ELSE 1 END, s.created_at DESC LIMIT 300");
  page(req, res, '판매자 심사', html`${head('판매자 심사', '승인된 판매자만 상품 심사를 요청하고 정산을 받을 수 있습니다')}
    ${rows.length ? rows.map((s) => card('', html`
      <p><b>${s.display_name}</b> ${badge('seller', s.status)} <span class="muted">${s.name} · ${s.email} · ${{ individual: '개인', sole: '개인사업자', corp: '법인' }[s.biz_type]}${s.biz_no ? ` · ${s.biz_no}` : ''} · 신청 ${fmtDate(s.created_at, false)}</span></p>
      ${s.intro ? html`<p>${nl2br(s.intro)}</p>` : ''}${s.skills ? html`<p class="sub">기술: ${s.skills}</p>` : ''}${s.portfolio ? html`<p class="sub">포트폴리오: ${nl2br(s.portfolio)}</p>` : ''}
      ${s.review_note ? html`<p class="hint">이전 심사 메모: ${s.review_note} (${userName(s.reviewed_by)}, ${fmtDate(s.reviewed_at)})</p>` : ''}
      <form method="post" action="/admin/sellers/${s.user_id}" class="row">${csrf(req)}
        ${field('결과', 'status', s.status === 'approved' ? 'suspended' : 'approved', { options: [['approved', '승인'], ['rejected', '반려'], ['suspended', '정지']] })}${field('사유·메모', 'note', '')}
        <div class="field"><label>&nbsp;</label><button class="btn sm">처리</button></div></form>
      <form method="post" action="/admin/sellers/${s.user_id}/tax" class="row">${csrf(req)}
        ${field('과세 유형', 'tax_type', s.tax_type, { options: Object.entries(accounts.TAX_TYPES), hint: '사업자등록증 등으로 확인한 뒤 설정하세요. 개인은 지급 시 3.3%가 원천징수됩니다' })}
        ${field('간이과세자 세금계산서', 'simplified_invoice_ok', s.simplified_invoice_ok, { options: [[0, '수수 대상 아님'], [1, '수수 대상']] })}${field('확인 근거', 'note', '')}
        <div class="field"><label>&nbsp;</label><button class="btn sm">과세 유형 저장</button></div></form>`)) : html`<p class="empty">판매자 신청이 없습니다</p>`}`);
});
r.post('/admin/sellers/:id/tax', needStaff('review'), h(async (req, res) => {
  accounts.setTaxType(req.user, int(req.params.id), { taxType: req.body.tax_type, simplifiedInvoiceOk: req.body.simplified_invoice_ok === '1', note: req.body.note });
  res.flash('과세 유형을 저장했습니다. 이후 지급분부터 적용됩니다'); res.back('/admin/sellers');
}));

// ── 세무 증빙 기초 데이터
const TAX_DOC = { fee_tax_invoice: '수수료 세금계산서 발행 대상', fee_record: '수수료 정산 기록(세금계산서 대상 아님)', withholding: '사업소득 원천징수(지급명세서 기초)' };
const taxRows = (period) => q.all(`SELECT t.*, o.order_no, s.display_name, s.biz_no, u.name FROM tax_records t JOIN orders o ON o.id = t.order_id
  JOIN seller_profiles s ON s.user_id = t.seller_id JOIN users u ON u.id = t.seller_id WHERE (? = '' OR t.period = ?) ORDER BY t.id DESC LIMIT 2000`, period, period);
r.get('/admin/tax', needStaff('settlement'), (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.query.period || '') ? req.query.period : '';
  const rows = taxRows(period);
  const sum = (type, k) => rows.filter((x) => x.doc_type === type).reduce((a, x) => a + x[k], 0);
  page(req, res, '세무 증빙', html`${head('세무 증빙 기초 데이터', '지급 완료 건에 대해 생성됩니다. 실제 세금계산서 발행, 원천세 신고, 지급명세서 제출은 이 화면 밖에서 이루어집니다')}
    ${notice('세율, 절사, 소액부징수, 원천징수 의무자 판단은 세무 검토 전 기준입니다. 지급명세서에 필요한 소득자 식별정보는 이 시스템이 수집하지 않습니다', 'warn')}
    <form class="filters" method="get"><input type="text" name="period" value="${period}" placeholder="귀속 연월 2026-11"><button class="btn sm">조회</button><a class="btn sm" href="/admin/tax.csv?period=${period}">CSV 내려받기</a></form>
    ${card('합계', dl([
      ['세금계산서 대상 수수료', html`공급가액 ${won(sum('fee_tax_invoice', 'supply_amount'))} · 부가세 ${won(sum('fee_tax_invoice', 'vat_amount'))}`],
      ['세금계산서 대상 아닌 수수료', won(sum('fee_record', 'base_amount'))],
      ['원천징수', html`지급 대상액 ${won(sum('withholding', 'base_amount'))} · 소득세 ${won(sum('withholding', 'income_tax'))} · 지방소득세 ${won(sum('withholding', 'local_tax'))}`],
    ]))}
    ${table(['귀속', '판매자', '구분', '기준 금액', '공급가액 / 부가세', '소득세 / 지방소득세', '상태', ''], rows.map((x) => [x.period, html`${x.display_name}<br><span class="muted">${accounts.TAX_TYPES[x.seller_tax_type]}${x.biz_no ? ` · ${x.biz_no}` : ''}</span>`, html`${TAX_DOC[x.doc_type]}<br><a href="/admin/orders/${x.order_id}">${x.order_no}</a>`, won(x.base_amount),
      x.doc_type === 'withholding' ? '-' : `${won(x.supply_amount)} / ${won(x.vat_amount)}`, x.doc_type === 'withholding' ? `${won(x.income_tax)} / ${won(x.local_tax)}` : '-',
      x.status === 'issued' ? html`처리 기록됨<br><span class="muted">${x.issued_ref}</span>` : '기초 데이터',
      x.status === 'draft' ? html`<form method="post" action="/admin/tax/${x.id}/issued" class="inline">${csrf(req)}<input type="text" name="ref" placeholder="승인번호·신고 참조" required><button class="btn sm">처리 기록</button></form>` : '']), '해당 기간의 기록이 없습니다')}`);
});
r.get('/admin/tax.csv', needStaff('settlement'), (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.query.period || '') ? req.query.period : '';
  const cell = (v) => { const t = String(v ?? ''); return `"${(/^[=+\-@]/.test(t) ? "'" + t : t).replace(/"/g, '""')}"`; };
  const lines = [['귀속연월', '주문번호', '판매자', '사업자번호', '과세유형', '구분', '기준금액', '공급가액', '부가세', '소득세', '지방소득세', '상태', '참조'].map(cell).join(',')];
  for (const x of taxRows(period)) lines.push([x.period, x.order_no, x.display_name, x.biz_no, accounts.TAX_TYPES[x.seller_tax_type], TAX_DOC[x.doc_type], x.base_amount, x.supply_amount, x.vat_amount, x.income_tax, x.local_tax, x.status, x.issued_ref].map(cell).join(','));
  audit(req.user, 'tax.export', 'tax_records', period || 'all', { rows: lines.length - 1 }, req.ip);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="eum-tax-${period || 'all'}.csv"`, 'Cache-Control': 'no-store' });
  res.send('\ufeff' + lines.join('\r\n'));
});
r.post('/admin/tax/:id/issued', needStaff('settlement'), h(async (req, res) => {
  must(q.get("SELECT 1 FROM tax_records WHERE id = ? AND status = 'draft'", int(req.params.id)) && str(req.body.ref).length >= 2, '처리 참조를 입력하세요.');
  require('../services/tax').markIssued(req.user, int(req.params.id), req.body.ref);
  res.back('/admin/tax');
}));
r.post('/admin/sellers/:id', needStaff('review'), h(async (req, res) => {
  must(q.get('SELECT 1 FROM seller_profiles WHERE user_id = ?', int(req.params.id)), '판매자를 찾을 수 없습니다.', 404);
  if (req.body.status !== 'approved') must(str(req.body.note).length >= 5, '반려·정지 사유를 적어 주세요.');
  accounts.reviewSeller(req.user, int(req.params.id), { status: req.body.status, note: req.body.note });
  res.flash('처리했습니다'); res.back('/admin/sellers');
}));

// ── 상품·파일 심사
r.get('/admin/products', needStaff('review'), (req, res) => {
  const f = req.query.f || 'pending';
  const where = { pending: "(p.status = 'pending_review' OR EXISTS (SELECT 1 FROM product_versions v WHERE v.product_id = p.id AND v.status = 'submitted'))", blocked: 'p.sales_blocked = 1', all: '1=1' }[f] || '1=1';
  const rows = q.all(`SELECT p.*, s.display_name, (SELECT COUNT(*) FROM product_versions v WHERE v.product_id = p.id AND v.status = 'submitted') AS submitted FROM products p JOIN seller_profiles s ON s.user_id = p.seller_id WHERE ${where} ORDER BY p.updated_at DESC LIMIT 300`);
  page(req, res, '상품·파일 심사', html`${head('상품·파일 심사')}
    <div class="filters"><a class="btn sm" href="?f=pending">심사 대기</a><a class="btn sm" href="?f=blocked">판매 제한</a><a class="btn sm" href="?f=all">전체</a></div>
    ${table(['상품', '판매자', '유형', '상태', '수정'], rows.map((p) => [html`<a href="/admin/products/${p.id}">${p.title}</a>${p.submitted ? html` ${tag('새 버전 제출됨', 'warn')}` : ''}${p.sales_blocked ? html` ${tag('신규 판매 제한', 'bad')}` : ''}`, p.display_name, p.type === 'source' ? '소스코드' : '사용권', badge('product', p.status), fmtDate(p.updated_at)]), '해당하는 상품이 없습니다')}`);
});

function versionCard(req, title, v) {
  if (!v) return '';
  const files = catalog.versionFiles(v.id);
  return card(title, html`<p class="sub">버전 ${v.label} · ${{ draft: '작성 중', submitted: '제출됨(심사 대기)', approved: '승인됨', rejected: '반려됨' }[v.status]} ${v.manifest_hash ? html`· 목록 지문 ${hashChip(v.manifest_hash)}` : ''} ${v.submitted_at ? `· 제출 ${fmtDate(v.submitted_at)}` : ''}</p>
    ${files.map((f) => {
      const rep = JSON.parse(f.scan_report || '{}');
      return html`<div class="card flat"><p><b>${f.original_name}</b> <span class="muted">${ROLES[f.role] || f.role} · ${ui.size(f.size)}</span> ${hashChip(f.sha256, 16)}</p>
        <p>${V.scanCells(f)}${f.scan_override_by ? html` ${tag('예외 승인됨', 'warn')} <span class="muted">${userName(f.scan_override_by)}: ${f.scan_override_reason}</span>` : ''}</p>
        ${(rep.problems || []).length ? html`<p class="sub">압축 구조 문제</p><ul class="list">${rep.problems.map((x) => html`<li>${x}</li>`)}</ul>` : ''}
        ${(rep.findings || []).length ? html`<p class="sub">비밀값·개인정보 의심 항목(값 자체는 저장하지 않음)</p><ul class="list">${rep.findings.map((x) => html`<li>${x.label} — ${x.entry}${x.line ? `:${x.line}` : ''}</li>`)}</ul>` : ''}
        ${(rep.notes || []).length ? html`<p class="hint">${rep.notes.join(' / ')}</p>` : ''}
        <div class="actions">${postBtn(req, `/admin/files/${f.id}/link`, '파일 내려받기(감사 기록됨)', { cls: 'sm' })}</div>
        ${[f.scan_malware, f.scan_secrets, f.scan_archive].includes('flagged') && !f.scan_override_by ? html`<form method="post" action="/admin/files/${f.id}/override" class="mt">${csrf(req)}${field('예외 승인 사유', 'reason', '', { required: true, hint: '직접 확인한 내용을 10자 이상 적어 주세요. 오탐으로 판단한 근거가 남습니다' })}<button class="btn sm danger">문제 발견 파일 예외 승인</button></form>` : ''}</div>`;
    })}${files.length ? '' : html`<p class="empty">파일이 없습니다</p>`}`);
}

r.get('/admin/products/:id', needStaff('review'), (req, res) => {
  const p = q.get('SELECT p.*, s.display_name, s.status AS seller_status, c.name AS category_name FROM products p JOIN seller_profiles s ON s.user_id = p.seller_id LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?', int(req.params.id));
  if (!p) throw notFound();
  const submitted = q.get("SELECT * FROM product_versions WHERE product_id = ? AND status = 'submitted' ORDER BY id DESC", p.id);
  const current = p.current_version_id ? q.get('SELECT * FROM product_versions WHERE id = ?', p.current_version_id) : null;
  const opts = q.all('SELECT * FROM product_options WHERE product_id = ?', p.id);
  const vers = q.all('SELECT v.*, u.name FROM product_verifications v JOIN users u ON u.id = v.by_user WHERE v.product_id = ? ORDER BY v.id DESC', p.id);
  const KIND = { build_check: '빌드 확인', run_check: '실행 확인', rights_docs: '권리 자료 확인' };
  const malwareOnly = q.setting('require_malware_scan') === '1';
  page(req, res, p.title, html`${head(p.title, `${p.display_name} · ${p.type === 'source' ? '소스코드' : '사용권'} · ${p.category_name || '분류 없음'}`, html`<span>${badge('product', p.status)}${p.sales_blocked ? html` ${tag('신규 판매 제한', 'bad')}` : ''}</span>`)}
    ${p.seller_status !== 'approved' ? notice('판매자 심사가 승인 상태가 아닙니다', 'warn') : ''}
    ${card('심사', html`
      <p class="sub">승인하면 제출된 버전이 현재 판매 버전이 됩니다. 기존 주문은 주문 시점 버전에 고정되어 영향을 받지 않습니다${malwareOnly ? '. 현재 설정상 악성 파일 검사를 통과하지 않은(검사 불가 포함) 파일이 있으면 승인할 수 없습니다' : ''}</p>
      <form method="post" action="/admin/products/${p.id}/review">${csrf(req)}
        ${field('결과', 'approve', '1', { options: [['1', '승인'], ['0', '반려']] })}${field('메모·반려 사유', 'note', '', { rows: 2 })}<button class="btn primary">심사 결과 저장</button></form>
      ${p.review_note ? html`<p class="hint">이전 심사 메모: ${p.review_note}</p>` : ''}`)}
    ${versionCard(req, '제출된 새 버전(심사 대상)', submitted)}
    ${versionCard(req, '현재 판매 버전', current && (!submitted || current.id !== submitted.id) ? current : null)}
    ${card('상품 정보', dl([['요약', p.summary], ['해결하는 문제', nl2br(p.problem)], ['설명', nl2br(p.description)], ['기능', ui.bullets(p.features)], ['포함', ui.bullets(p.included)], ['제외', ui.bullets(p.excluded)],
      ['지원 환경', nl2br(p.environments)], ['설치 방법', nl2br(p.install_method)], ['체험 링크', p.demo_url], ['외부 유료 서비스', p.external_paid_required ? html`${tag('필요', 'warn')} ${nl2br(p.external_costs)}` : '없다고 고지'],
      ['제3자 라이선스', nl2br(p.third_party_licenses)], ['권리 범위', html`${V.LIC({ modify: p.lic_modify, commercial: p.lic_commercial, redistribute: p.lic_redistribute, resale: p.lic_resale }).map(([k, v]) => tag(`${k} ${v ? '허용' : '불가'}`, v ? 'ok' : ''))} ${nl2br(p.license_notes)}`],
      ['검수 기준', nl2br(p.inspection_criteria)], ['검수 기간', `${p.inspection_days}일`], ['환불·분쟁', nl2br(p.refund_policy)],
      ['옵션', table(['이름', '가격', '조건', '상태'], opts.map((o) => [o.name, won(o.price), `${o.term === 'term' ? `기간제 ${o.term_days}일` : '영구'}${o.includes_source ? ' · 소스 포함' : ''}${o.includes_install ? ' · 설치 포함' : ''}`, o.active ? '판매' : '중지']))]]))}
    ${card('검증 범위 기록', html`
      ${notice('빌드 확인, 실행 확인, 권리 자료 확인은 서로 다른 확인입니다. 어느 하나의 통과도 전체 품질이나 권리를 보증하지 않으며, 구매자 화면에도 확인한 범위 그대로 표시됩니다. 업로드된 코드는 운영 서버에서 실행하지 말고 분리된 일회성 격리 환경에서 확인하세요')}
      ${table(['일시', '항목', '결과', '확인 범위', '확인자'], vers.map((v) => [fmtDate(v.created_at), KIND[v.kind], tag(v.result === 'passed' ? '확인됨' : '문제 있음', v.result === 'passed' ? 'ok' : 'bad'), v.scope_note, v.name]), '기록이 없습니다')}
      <form method="post" action="/admin/products/${p.id}/verification" class="mt">${csrf(req)}<div class="row">${field('항목', 'kind', '', { options: Object.entries(KIND) })}${field('결과', 'result', '', { options: [['passed', '확인됨'], ['failed', '문제 있음']] })}</div>
        ${field('확인 범위', 'scope_note', '', { rows: 2, required: true, hint: '무엇을 어떤 환경에서 어디까지 확인했는지 적어 주세요' })}<button class="btn sm">기록 추가</button></form>`)}
    ${card('신규 판매 제한', html`<p class="sub">문제 상품의 새 주문을 막습니다. 기존 주문의 접근 권한과 분쟁 절차는 그대로 유지됩니다${p.sales_blocked ? ` · 현재 제한 사유: ${p.sales_blocked_reason}` : ''}</p>
      <form method="post" action="/admin/products/${p.id}/block">${csrf(req)}<input type="hidden" name="blocked" value="${p.sales_blocked ? '0' : '1'}">${field('사유', 'reason', '', { required: true })}<button class="btn sm ${p.sales_blocked ? '' : 'danger'}">${p.sales_blocked ? '판매 제한 해제' : '신규 판매 제한'}</button></form>`)}`);
});
r.post('/admin/products/:id/review', needStaff('review'), h(async (req, res) => { catalog.reviewProduct(req.user, int(req.params.id), { approve: req.body.approve === '1', note: req.body.note }); res.flash('심사 결과를 저장했습니다'); res.back('/admin/products'); }));
r.post('/admin/products/:id/verification', needStaff('review'), h(async (req, res) => { must(q.get('SELECT 1 FROM products WHERE id = ?', int(req.params.id)), '상품을 찾을 수 없습니다.', 404); catalog.addVerification(req.user, int(req.params.id), { kind: req.body.kind, result: req.body.result, scopeNote: req.body.scope_note }); res.flash('기록했습니다'); res.back(); }));
r.post('/admin/products/:id/block', needStaff('review', 'support'), h(async (req, res) => {
  must(q.get('SELECT 1 FROM products WHERE id = ?', int(req.params.id)), '상품을 찾을 수 없습니다.', 404);
  must(str(req.body.reason).length >= 5, '사유를 적어 주세요.');
  catalog.setSalesBlock(req.user, int(req.params.id), req.body.blocked === '1', req.body.reason); res.flash('처리했습니다'); res.back();
}));
r.post('/admin/files/:fid/override', needStaff('review'), h(async (req, res) => { must(q.get('SELECT 1 FROM files WHERE id = ?', int(req.params.fid)), '파일을 찾을 수 없습니다.', 404); catalog.overrideScan(req.user, int(req.params.fid), req.body.reason); res.flash('예외 승인을 기록했습니다'); res.back(); }));

// ── 거래 상태
const ORDER_FILTERS = {
  late_delivery: ['미납품·납품 지연', "delivery_status IN ('awaiting_seller','redelivery_requested') AND payment_status IN ('paid','partially_refunded')"],
  late_inspection: ['검수 지연', "inspection_status = 'in_progress' AND inspection_due_at < @now"],
  close_review: ['검수 종료 심사 요청', "inspection_status = 'in_progress' AND close_review_requested_at IS NOT NULL"],
  access_failed: ['파일 접근 실패', "delivery_status = 'access_failed'"],
  dispute: ['분쟁', "dispute_status = 'open'"],
  extra: ['별도 확인 대기', 'extra_verification = 1 AND extra_verified_at IS NULL'],
  clawback: ['사후 회수 검토', "payout_status = 'clawback_review'"],
};
r.get('/admin/orders', needStaff('support', 'settlement'), (req, res) => {
  const where = ["payment_status <> 'none'"], args = {};
  if (ORDER_FILTERS[req.query.f]) { where.push(ORDER_FILTERS[req.query.f][1]); if (req.query.f === 'late_inspection') args.now = clock.iso(); }
  if (ui.LABELS.payout[req.query.payout]) { where.push('payout_status = @payout'); args.payout = req.query.payout; }
  if (req.query.q) { where.push('(order_no LIKE @k OR title LIKE @k)'); args.k = `%${str(req.query.q, 60)}%`; }
  const rows = require('../db').get().prepare(`SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 300`).all(args);
  page(req, res, '거래 상태', html`${head('거래 상태', '주문마다 결제·대금 보호·납품·검수·분쟁·환불·지급 상태를 따로 봅니다')}
    <form class="filters" method="get"><select name="f"><option value="">전체</option>${Object.entries(ORDER_FILTERS).map(([k, [l]]) => html`<option value="${k}" ${req.query.f === k ? ui.raw('selected') : ''}>${l}</option>`)}</select>
      <select name="payout"><option value="">지급 상태 전체</option>${Object.entries(ui.LABELS.payout).map(([k, [l]]) => html`<option value="${k}" ${req.query.payout === k ? ui.raw('selected') : ''}>${l}</option>`)}</select>
      <input type="search" name="q" value="${req.query.q || ''}" placeholder="주문번호·제목"><button class="btn sm">검색</button></form>
    ${table(['주문', '금액', '결제', '보호', '납품', '검수', '분쟁', '환불', '지급'], rows.map((o) => [html`<a href="/admin/orders/${o.id}">${o.order_no}</a><br><span class="muted">${o.title}</span>`, won(o.amount), badge('payment', o.payment_status), badge('protection', o.protection_status), html`${badge('delivery', o.delivery_status)}${o.delivery_due_at && o.delivery_status !== 'delivered' ? html`<br><span class="muted">~${fmtDate(o.delivery_due_at, false)}</span>` : ''}`,
      html`${badge('inspection', o.inspection_status)}${o.inspection_status === 'in_progress' ? html`<br><span class="muted">~${fmtDate(o.inspection_due_at, false)}</span>` : ''}`, badge('dispute', o.dispute_status), badge('refund', o.refund_status), badge('payout', o.payout_status)]), '해당하는 주문이 없습니다')}`);
});

r.get('/admin/orders/:id', needStaff('support', 'settlement'), (req, res) => {
  const o = orders.getOrder(int(req.params.id));
  if (!o) throw notFound();
  const pays = q.all('SELECT * FROM payments WHERE order_id = ? ORDER BY id', o.id);
  const prots = q.all('SELECT * FROM protection_records WHERE order_id = ? ORDER BY id', o.id);
  const dls = q.all('SELECT d.*, u.name, f.original_name FROM download_logs d LEFT JOIN users u ON u.id = d.user_id LEFT JOIN files f ON f.id = d.file_id WHERE d.order_id = ? ORDER BY d.id DESC LIMIT 100', o.id);
  const ds = q.all('SELECT * FROM disputes WHERE order_id = ? ORDER BY id DESC', o.id);
  const pos = q.all('SELECT * FROM payouts WHERE order_id = ? ORDER BY id', o.id);
  const rfs = q.all('SELECT * FROM refunds WHERE order_id = ? ORDER BY id', o.id);
  const sim = disputes.similar(o);
  const overdue = o.inspection_status === 'in_progress' && o.delivery_status === 'delivered' && o.inspection_due_at < clock.iso() && o.dispute_status !== 'open';
  const sup = has(req.user, 'support'), stl = has(req.user, 'settlement');
  page(req, res, o.order_no, html`${head(o.title, `구매자 ${userName(o.buyer_id)} · 판매자 ${userName(o.seller_id)} · 주문 ${fmtDate(o.created_at)}`, html`<a class="btn sm" href="/orders/${o.id}/document">거래 문서</a>`)}
    ${V.ledgerPanel(o, 'staff')}
    ${o.payout_status === 'clawback_review' ? notice('이미 판매자에게 지급된 거래입니다. 일반 보류·환불 절차로 되돌릴 수 없으며 사후 환불·회수 검토로 진행합니다(판매자 협의, 상계, 법적 절차 안내 등). 처리 결과는 환불 화면의 수동 처리에 기록하세요', 'bad') : ''}
    ${card('결제·대금 보호 기록', html`<p class="sub">내부 상태와 결제 사업자가 응답한 상태 원문을 나란히 둡니다. 서로 다르면 대사에서 불일치로 잡힙니다</p>
      ${table(['사업자', '구분', '결제 ID', '수단', '금액', '내부 상태', '사업자 상태 원문', '사업자 환불액', '최근 조회'], pays.map((p) => [p.provider, p.mode === 'test' ? tag('테스트', 'warn') : tag('실결제'), html`<code>${p.provider_payment_id || '-'}</code>`, p.method || '-', won(p.amount), p.status, p.provider_status || '-', won(p.provider_refunded), fmtDate(p.last_synced_at)]), '결제 기록이 없습니다')}
      ${table(['일시', '사업자', '사업자 보호 상태', '보류 한도', '사업자 자동확정', '분쟁 보류 요청 결과', '비고'], prots.map((p) => [fmtDate(p.created_at), p.provider, p.state, fmtDate(p.hold_until, false), fmtDate(p.auto_confirm_at, false), p.hold_request, p.detail]), '대금 보호 기록이 없습니다')}`)}
    ${V.filesCard(req, o, 'staff', `/admin/orders/${o.id}`)}
    ${card('운영자 처리', html`
      ${o.delivery_status === 'access_failed' && sup ? html`<h3>파일 접근 복구</h3><p class="sub">저장소 문제를 해결한 뒤 다시 시도하세요. 성공한 시점부터 검수 기간이 시작됩니다</p>${postBtn(req, `/admin/orders/${o.id}/retry-access`, '접근 복구 재시도')}` : ''}
      ${overdue && sup ? html`<h3>검수 종료</h3><p class="sub">검수 기한 ${fmtDate(o.inspection_due_at)} 경과${o.close_review_requested_at ? ` · 판매자 심사 요청 ${fmtDate(o.close_review_requested_at)}` : ''}. 구매자의 미응답과 납품·다운로드 기록을 확인한 뒤 근거를 남기세요</p>
        <form method="post" action="/admin/orders/${o.id}/close-inspection">${csrf(req)}${field('처리 근거', 'reason', '', { rows: 2, required: true })}<button class="btn">검수 종료 처리</button></form>` : ''}
      ${o.extra_verification ? html`<h3>고액·권리 거래 별도 확인</h3>${o.extra_verified_at ? html`<p>${fmtDate(o.extra_verified_at)} ${userName(o.extra_verified_by)} 확인 완료</p>` : html`<p class="sub">이 확인이 끝나기 전에는 판매자 지급이 요청되지 않습니다</p>
        <form method="post" action="/admin/orders/${o.id}/extra-verify">${csrf(req)}${field('확인 내용', 'note', '', { rows: 2, required: true, hint: '당사자 확인, 권리 이전 절차 자료 등 무엇을 확인했는지' })}<button class="btn">확인 완료 기록</button></form>`}` : ''}
      ${stl && o.payout_status === 'eligible' ? html`<h3>지급 요청</h3>${postBtn(req, `/admin/orders/${o.id}/payout`, '판매자 지급 요청')}` : ''}
      <p class="hint">환불과 분쟁 결정은 분쟁 화면에서 근거와 함께 처리합니다</p>`)}
    ${V.blockersCard(o)}${V.moneyCard(o, 'staff')}
    ${ds.length ? card('분쟁', table(['접수', '유형', '상태', '외부 지급 보류', ''], ds.map((d) => [fmtDate(d.created_at), disputes.REASONS[d.reason_code], d.status, d.external_hold, html`<a href="/admin/disputes/${d.id}">열기</a>`]))) : ''}
    ${pos.length ? card('지급 기록', table(['멱등 키', '금액', '방식', '상태', '사업자 상태', '시도', '오류'], pos.map((p) => [html`<code>${p.idempotency_key}</code>`, won(p.amount), p.method === 'manual' ? '수동' : '사업자 API', p.status, p.provider_status || '-', p.attempts, p.last_error || '-']))) : ''}
    ${rfs.length ? card('환불 기록', table(['멱등 키', '금액', '상태', '사유', '비고'], rfs.map((x) => [html`<code>${x.idempotency_key}</code>`, won(x.amount), badge('refund', x.status), x.reason, x.decision_note || '-']))) : ''}
    ${card('유사 피해 확인', html`<p class="sub">같은 판매자의 같은 상품 주문과 분쟁 이력입니다</p>${table(['주문', '결제', '분쟁', '유형', '일시'], sim.map((s) => [html`<a href="/admin/orders/${s.id}">${s.order_no}</a> <span class="muted">${s.title}</span>`, badge('payment', s.payment_status), badge('dispute', s.dispute_status), s.reason_code ? disputes.REASONS[s.reason_code] : '-', fmtDate(s.created_at, false)]), '해당 주문이 없습니다')}`)}
    ${card('다운로드·접근 기록', table(['일시', '사용자', '파일', '구분', '결과', 'IP'], dls.map((d) => [fmtDate(d.created_at), d.name || '-', d.original_name || '-', d.context, d.result === 'ok' ? tag('허용', 'ok') : tag(d.result, 'bad'), d.ip || '-']), '기록이 없습니다'))}
    ${V.termsCard(o)}${V.timeline(o)}`);
});
r.post('/admin/orders/:id/files/:fid/link', needStaff('support', 'settlement'), h(async (req, res) => {
  const o = orders.getOrder(int(req.params.id));
  must(o && orders.orderFiles(o).some((f) => f.id === int(req.params.fid)), '이 주문의 파일이 아닙니다.', 404);
  res.redirect(303, '/dl/' + access.issue(req.user, { orderId: o.id, fileId: int(req.params.fid), context: 'admin' }, req));
}));
r.post('/admin/orders/:id/retry-access', needStaff('support'), h(async (req, res) => {
  const ok = orders.grantAccess(int(req.params.id));
  audit(req.user, 'order.retry_access', 'order', req.params.id, { ok }, req.ip);
  res.flash(ok ? '접근이 복구되어 검수 기간이 시작되었습니다' : '아직 파일을 읽을 수 없습니다', ok ? 'ok' : 'error'); res.back();
}));
r.post('/admin/orders/:id/close-inspection', needStaff('support'), h(async (req, res) => { inspection.closeByAdmin(req.user, int(req.params.id), req.body.reason); res.flash('검수를 종료 처리했습니다'); res.back(); }));
r.post('/admin/orders/:id/extra-verify', needStaff('support', 'settlement'), h(async (req, res) => {
  const o = orders.getOrder(int(req.params.id));
  must(o && o.extra_verification && !o.extra_verified_at, '별도 확인 대기 건이 아닙니다.', 409);
  must(str(req.body.note).length >= 10, '확인 내용을 10자 이상 적어 주세요.');
  q.update('orders', o.id, { extra_verified_by: req.user.id, extra_verified_at: clock.iso() });
  audit(req.user, 'order.extra_verify', 'order', o.id, { note: str(req.body.note, 1000) }, req.ip);
  settlement.refresh(o.id);
  res.flash('별도 확인을 기록했습니다'); res.back();
}));
r.post('/admin/orders/:id/payout', needStaff('settlement'), h(async (req, res) => {
  const p = await settlement.requestPayout(req.user, int(req.params.id));
  res.flash(p.method === 'manual' ? '수동 지급 대기로 등록했습니다. 이체 후 증빙을 기록하세요' : `지급 요청 결과: ${p.status === 'paid' ? '지급 완료' : p.status === 'requested' ? '요청 접수(완료 아님)' : p.status === 'unknown' ? '결과 확인 중' : '실패 — ' + p.last_error}`, p.status === 'failed' ? 'error' : 'ok');
  res.back();
}));

// ── 분쟁
r.get('/admin/disputes', needStaff('support'), (req, res) => {
  const rows = q.all("SELECT d.*, o.order_no, o.title, o.amount FROM disputes d JOIN orders o ON o.id = d.order_id ORDER BY CASE d.status WHEN 'appealed' THEN 0 WHEN 'admin_review' THEN 1 WHEN 'open' THEN 2 WHEN 'external' THEN 3 ELSE 4 END, d.id DESC LIMIT 300");
  const ST = { open: ['당사자 협의 중', 'warn'], admin_review: ['운영자 판단 요청', 'bad'], appealed: ['이의제기', 'bad'], external: ['외부 절차 안내', 'warn'], resolved: ['종결', ''] };
  page(req, res, '분쟁', html`${head('분쟁', '결정은 사람이 근거와 함께 내립니다')}
    ${table(['접수', '주문', '유형', '상태', '내부 정산', '외부 지급 보류', '결과'], rows.map((d) => [fmtDate(d.created_at), html`<a href="/admin/disputes/${d.id}">${d.order_no}</a><br><span class="muted">${d.title} · ${won(d.amount)}</span>`, disputes.REASONS[d.reason_code], tag(...ST[d.status]), d.post_payout ? tag('이미 정산됨', 'bad') : '보류', HOLD[d.external_hold], d.resolution ? disputes.OUTCOMES[d.resolution] : '-']), '분쟁이 없습니다')}`);
});
const HOLD = { none: '-', requested: '요청 중', confirmed: '사업자 확인됨', failed: '요청 실패', unsupported: '미지원', not_applicable: '해당 없음(이미 지급)' };

r.get('/admin/disputes/:id', needStaff('support'), (req, res) => {
  const d = disputes.getDispute(int(req.params.id));
  if (!d) throw notFound();
  const o = orders.getOrder(d.order_id);
  const entries = q.all('SELECT e.*, u.name, f.original_name FROM dispute_entries e JOIN users u ON u.id = e.user_id LEFT JOIN files f ON f.id = e.file_id WHERE e.dispute_id = ? ORDER BY e.id', d.id);
  const side = (uid) => (uid === o.buyer_id ? '구매자' : uid === o.seller_id ? '판매자' : '운영자');
  const KIND = { statement: '진술', evidence: '증빙', proposal: '합의 제안', proposal_accept: '제안 수락', proposal_decline: '제안 거절', admin_note: '운영자 메모' };
  const open = ['open', 'admin_review', 'appealed', 'external'].includes(d.status);
  const canDecide = open && (d.status !== 'appealed' || req.user.staff.includes('super'));
  const sim = disputes.similar(o);
  const remain = o.amount - o.refunded_amount;
  page(req, res, `분쟁 #${d.id}`, html`${head(`분쟁 #${d.id} — ${disputes.REASONS[d.reason_code]}`, html`<a href="/admin/orders/${o.id}">${o.order_no}</a> · ${o.title} · 제기 ${side(d.opened_by)} ${userName(d.opened_by)} · ${fmtDate(d.created_at)}`)}
    ${V.ledgerPanel(o, 'staff')}
    ${card('보류 상태', html`${dl([
      ['내부 정산 보류', d.post_payout ? html`${tag('이미 정산됨 — 사후 환불·회수 검토', 'bad')} 판매자에게 지급이 끝난 거래라 보류할 금액이 없습니다` : html`${badge('payout', o.payout_status)} 플랫폼이 판매자 지급 요청을 보내지 않는 상태입니다`],
      ['외부 지급 보류', html`${tag(HOLD[d.external_hold], d.external_hold === 'confirmed' ? 'ok' : d.external_hold === 'failed' ? 'bad' : 'warn')} ${d.external_hold_detail}`],
    ])}<p class="hint">분쟁 상태 변경만으로 결제 사업자의 지급이 멈추지 않습니다. 외부 보류는 사업자가 확인한 경우에만 '확인됨'으로 표시됩니다</p>`)}
    ${card('접수 내용', html`<p>${nl2br(d.description)}</p><p class="sub">원하는 처리: ${disputes.OUTCOMES[d.requested_outcome] || '지정 없음'}</p>`)}
    ${card('양측 자료', html`${entries.length ? entries.map((e) => html`<div class="card flat"><p><b>${side(e.user_id)}</b> ${e.name} · ${KIND[e.kind]} <span class="muted">${fmtDate(e.created_at)}</span></p>
        ${e.kind === 'proposal' ? html`<p>${tag(disputes.OUTCOMES[e.proposal_type])}${e.proposal_amount ? ` ${won(e.proposal_amount)}` : ''}</p>` : ''}
        ${['proposal_accept', 'proposal_decline'].includes(e.kind) ? html`<p class="sub">제안 #${e.body}</p>` : html`<p>${nl2br(e.body)}</p>`}
        ${e.file_id ? html`<div class="actions"><span class="muted">${e.original_name}</span>${postBtn(req, `/admin/files/${e.file_id}/link`, '증빙 내려받기(감사 기록됨)', { cls: 'sm' })}</div>` : ''}</div>`) : html`<p class="empty">제출된 자료가 없습니다</p>`}
      ${open ? html`<form method="post" action="/admin/disputes/${d.id}/note">${csrf(req)}${field('운영자 메모(양측에 공개)', 'body', '', { rows: 2, required: true })}<button class="btn sm">메모 추가</button></form>` : ''}`)}
    ${d.resolution ? card('처리 결과', dl([['결과', html`${disputes.OUTCOMES[d.resolution]}${d.resolution_amount ? ` ${won(d.resolution_amount)}` : ''}`], ['근거', nl2br(d.resolution_reason)], ['처리자', d.resolved_by ? userName(d.resolved_by) : '양측 합의'], ['일시', fmtDate(d.resolved_at)], ['이의제기 기한', d.appeal_deadline ? fmtDate(d.appeal_deadline) : '없음(합의 또는 최종 결정)'],
      d.appeal_at && ['이의제기', html`${side(d.appeal_by)} ${userName(d.appeal_by)} · ${fmtDate(d.appeal_at)}<br>${nl2br(d.appeal_text)}`]])) : ''}
    ${open ? card(d.status === 'appealed' ? '이의제기 재결정(최종)' : '운영자 결정', canDecide ? html`
      <p class="sub">결정에는 근거, 처리자, 일시가 기록되고 양측에 결과와 이의제기 방법이 안내됩니다. 환불은 결제 사업자의 취소 성공이 확인되어야 완료로 바뀝니다${d.post_payout ? '. 이미 정산된 거래이므로 환불 결정은 일반 결제 취소가 아니라 사후 환불·회수 검토(수동 처리)로 이어집니다' : ''}</p>
      <form method="post" action="/admin/disputes/${d.id}/resolve">${csrf(req)}
        <div class="row">${field('처리 결과', 'resolution', '', { options: Object.entries(disputes.OUTCOMES) })}${field('부분 환불 금액(원)', 'amount', '', { hint: `부분 환불일 때만. 환불 가능 잔액 ${won(remain)}` })}</div>
        ${field('판단 근거', 'reason', '', { rows: 4, required: true, hint: '어떤 계약 기준과 자료에 근거했는지 10자 이상' })}
        <button class="btn primary">결정 저장</button></form>` : notice('이의제기 건은 최고관리자가 처리합니다', 'warn')) : ''}
    ${card('외부 해결 절차 안내', html`<p class="sub">${disputes.EXTERNAL_GUIDE}</p>`)}
    ${card('유사 피해 확인', table(['주문', '결제', '분쟁', '유형', '일시'], sim.map((s) => [html`<a href="/admin/orders/${s.id}">${s.order_no}</a> <span class="muted">${s.title}</span>`, badge('payment', s.payment_status), badge('dispute', s.dispute_status), s.reason_code ? disputes.REASONS[s.reason_code] : '-', fmtDate(s.created_at, false)]), '같은 판매자·상품의 다른 주문이 없습니다'))}`);
});
r.post('/admin/disputes/:id/note', needStaff('support'), h(async (req, res) => {
  const d = disputes.getDispute(int(req.params.id));
  must(d && ['open', 'admin_review', 'appealed', 'external'].includes(d.status), '종결된 분쟁입니다.', 409);
  must(str(req.body.body).length >= 2, '내용을 입력하세요.');
  q.insert('dispute_entries', { dispute_id: d.id, user_id: req.user.id, kind: 'admin_note', body: str(req.body.body), created_at: clock.iso() });
  audit(req.user, 'dispute.note', 'dispute', d.id, {}, req.ip);
  const o = orders.getOrder(d.order_id);
  for (const uid of [o.buyer_id, o.seller_id]) notify(uid, '분쟁에 운영자 메모가 등록되었습니다', o.title, `/disputes/${d.id}`);
  res.back();
}));
r.post('/admin/disputes/:id/resolve', needStaff('support'), h(async (req, res) => {
  const amount = req.body.resolution === 'refund_partial' ? toWon(req.body.amount) : undefined;
  const result = await disputes.resolve(req.user, int(req.params.id), { resolution: req.body.resolution, amount, reason: req.body.reason });
  const st = result?.status;
  res.flash('결정을 저장했습니다' + (st === 'completed' ? ' · 환불 완료(결제 취소 확인)' : st === 'processing' ? ' · 환불 처리 중(아직 완료 아님)' : st === 'manual_required' ? ' · 환불은 수동 처리가 필요합니다(환불 화면 확인)' : st === 'failed' ? ' · 환불 실패 — 환불 화면에서 확인하세요' : ''), st === 'failed' ? 'error' : 'ok');
  res.back();
}));

// ── 정산·지급
const PO = { created: ['수동 지급 대기', 'warn'], requested: ['요청 접수(미완료)', 'warn'], unknown: ['결과 확인 중', 'warn'], paid: ['지급 완료', 'ok'], failed: ['실패', 'bad'] };
r.get('/admin/payouts', needStaff('settlement'), (req, res) => {
  const rows = q.all("SELECT p.*, o.order_no, s.display_name, b.bank, b.holder, b.account_last4 FROM payouts p JOIN orders o ON o.id = p.order_id LEFT JOIN seller_profiles s ON s.user_id = p.seller_id LEFT JOIN seller_bank_accounts b ON b.id = p.bank_account_id ORDER BY CASE p.status WHEN 'created' THEN 0 WHEN 'unknown' THEN 1 WHEN 'requested' THEN 2 ELSE 3 END, p.id DESC LIMIT 300");
  const eligible = q.get("SELECT COUNT(*) c FROM orders WHERE payout_status = 'eligible'").c;
  const caps = providers.caps();
  page(req, res, '정산·지급', html`${head('정산·지급', '요청 접수와 지급 완료는 다릅니다. 완료는 결제 사업자 조회 또는 이체 증빙으로만 기록합니다')}
    ${caps.payout_api ? '' : notice('현재 결제 사업자의 지급 API가 확인·연동되어 있지 않습니다. 지급 요청은 수동 지급 대기로 등록되며, 운영자가 직접 이체한 뒤 증빙을 남겨야 완료됩니다', 'warn')}
    ${card('정산 실행', html`<p class="sub">지급 요청 가능 주문 ${eligible}건 · 정산 주기 ${q.setting('settlement_cycle') === 'weekly' ? '주 1회(월요일)' : '구매확정 시'}. 접수·불명확 건의 결과 조회도 함께 합니다</p>${postBtn(req, '/admin/payouts/run', '정산 주기 지금 실행')}`)}
    ${rows.length ? rows.map((p) => card('', html`<p><a href="/admin/orders/${p.order_id}">${p.order_no}</a> · ${p.display_name || userName(p.seller_id)} · <b>${won(p.amount)}</b> ${tag(...PO[p.status])} <span class="muted">${p.method === 'manual' ? '수동 이체' : '사업자 API'} · <code>${p.idempotency_key}</code></span></p>
      <p class="sub">계좌 ${p.bank || '-'} ${p.holder || ''} ****${p.account_last4 || ''} · 생성 ${fmtDate(p.created_at)}${p.requested_at ? ` · 요청 ${fmtDate(p.requested_at)}` : ''}${p.paid_at ? ` · 완료 ${fmtDate(p.paid_at)}` : ''} · 사업자 상태 ${p.provider_status || '-'} · 시도 ${p.attempts}회${p.last_error ? ` · ${p.last_error}` : ''}${p.manual_evidence ? ` · 증빙: ${p.manual_evidence}` : ''}</p>
      <div class="actions">${['requested', 'unknown'].includes(p.status) && p.method === 'provider' ? postBtn(req, `/admin/payouts/${p.id}/poll`, '사업자에 결과 조회', { cls: 'sm' }) : ''}
        ${p.status === 'created' && p.method === 'manual' ? postBtn(req, `/admin/payouts/${p.id}/reveal`, '전체 계좌번호 보기(감사 기록됨)', { cls: 'sm' }) : ''}</div>
      ${p.status === 'created' && p.method === 'manual' ? html`<form method="post" action="/admin/payouts/${p.id}/manual" class="mt">${csrf(req)}${field('이체 증빙 또는 취소 사유', 'evidence', '', { required: true, hint: '이체 일시, 거래번호 등' })}
        <div class="actions"><button class="btn sm primary" name="action" value="paid">이체 완료 기록</button><button class="btn sm danger" name="action" value="cancel">지급 취소</button></div></form>` : ''}`)) : html`<p class="empty">지급 내역이 없습니다</p>`}`);
});
r.post('/admin/payouts/run', needStaff('settlement'), h(async (req, res) => { await settlement.tick({ force: true }); audit(req.user, 'settlement.run', '', '', {}, req.ip); res.flash('정산 주기를 실행했습니다. 아래 목록에서 결과를 확인하세요'); res.back('/admin/payouts'); }));
r.post('/admin/payouts/:id/poll', needStaff('settlement'), h(async (req, res) => { const p = await settlement.poll(int(req.params.id)); must(p, '지급 건을 찾을 수 없습니다.', 404); res.flash(`조회 결과: ${PO[p.status][0]}`); res.back('/admin/payouts'); }));
r.post('/admin/payouts/:id/manual', needStaff('settlement'), h(async (req, res) => {
  if (req.body.action === 'cancel') { must(str(req.body.evidence).length >= 5, '취소 사유를 적어 주세요.'); settlement.cancelManual(req.user, int(req.params.id), req.body.evidence); res.flash('지급을 취소했습니다'); }
  else { settlement.markManualPaid(req.user, int(req.params.id), req.body.evidence); res.flash('지급 완료로 기록했습니다'); }
  res.back('/admin/payouts');
}));
r.post('/admin/payouts/:id/reveal', needStaff('settlement'), h(async (req, res) => {
  const p = q.get('SELECT * FROM payouts WHERE id = ?', int(req.params.id));
  must(p && p.method === 'manual' && p.status === 'created', '수동 지급 대기 건에서만 계좌번호를 볼 수 있습니다.', 409);
  const b = q.get('SELECT * FROM seller_bank_accounts WHERE id = ?', p.bank_account_id);
  must(b, '계좌 정보를 찾을 수 없습니다.', 404);
  audit(req.user, 'bank.reveal', 'payout', p.id, { bank_account_id: b.id }, req.ip);
  res.set('Cache-Control', 'no-store');
  page(req, res, '계좌 확인', html`${head('수동 지급 계좌', p.idempotency_key)}${card('', html`${dl([['은행', b.bank], ['예금주', b.holder], ['계좌번호', html`<code>${storage.decryptText(b.account_enc)}</code>`], ['지급액', won(p.amount)]])}
    <p class="hint">이 조회는 감사 기록에 남았습니다. 이체 후 지급 화면에서 증빙을 기록하세요</p><a class="btn" href="/admin/payouts">지급 화면으로</a>`)}`);
}));

// ── 환불
r.get('/admin/refunds', needStaff('settlement'), (req, res) => {
  const rows = q.all("SELECT r.*, o.order_no, o.title, o.payout_status FROM refunds r JOIN orders o ON o.id = r.order_id ORDER BY CASE r.status WHEN 'manual_required' THEN 0 WHEN 'processing' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END, r.id DESC LIMIT 300");
  page(req, res, '환불', html`${head('환불', '환불 요청과 환불 완료는 다릅니다. 완료는 결제 취소 성공이 확인된 건만 표시됩니다')}
    ${card('처리 중 환불 재확인', html`<p class="sub">응답이 불명확했던 환불을 결제 사업자에 다시 조회합니다</p>${postBtn(req, '/admin/refunds/recheck', '사업자에 재확인')}`)}
    ${rows.length ? rows.map((x) => card('', html`<p><a href="/admin/orders/${x.order_id}">${x.order_no}</a> · ${x.title} · <b>${won(x.amount)}</b> ${badge('refund', x.status)} <span class="muted"><code>${x.idempotency_key}</code> · ${fmtDate(x.created_at)}${x.completed_at ? ` · 완료 ${fmtDate(x.completed_at)}` : ''}</span></p>
      <p class="sub">사유: ${x.reason}${x.decision_note ? ` · ${x.decision_note}` : ''}${x.provider_status ? ` · 사업자 응답: ${x.provider_status}` : ''}</p>
      ${x.status === 'manual_required' ? html`${x.payout_status === 'clawback_review' ? notice('이미 판매자에게 지급된 거래입니다. 판매자로부터의 회수 여부와 구매자 환불 방법을 검토한 뒤 결과를 기록하세요', 'bad') : notice('결제수단이 부분 취소를 지원하지 않습니다. 대체 절차(전액 취소 후 재결제, 계좌 환불 등)로 처리한 뒤 결과를 기록하세요', 'warn')}
        <form method="post" action="/admin/refunds/${x.id}/manual">${csrf(req)}${field('처리 내용·증빙', 'note', '', { rows: 2, required: true })}
        <div class="actions"><button class="btn sm primary" name="done" value="1">수동 환불 완료 기록</button><button class="btn sm" name="done" value="0">환불 불가로 종결</button></div></form>` : ''}
      ${x.status === 'failed' && x.id === q.get('SELECT MAX(id) m FROM refunds WHERE order_id = ?', x.order_id).m ? html`<p class="sub">결제 사업자가 취소를 거절했습니다. 원인을 확인한 뒤 다시 요청할 수 있습니다</p>${postBtn(req, `/admin/refunds/${x.id}/retry`, '환불 다시 요청', { cls: 'sm' })}` : ''}`)) : html`<p class="empty">환불 내역이 없습니다</p>`}`);
});
r.post('/admin/refunds/:id/retry', needStaff('settlement'), h(async (req, res) => {
  const x = q.get("SELECT * FROM refunds WHERE id = ? AND status = 'failed'", int(req.params.id));
  must(x, '다시 요청할 수 있는 환불이 아닙니다.', 409);
  const out = await refunds.execute(req.user, x.order_id, x.amount, { disputeId: x.dispute_id, reason: x.reason });
  res.flash(`다시 요청했습니다 — 현재 상태: ${out.status}`); res.back('/admin/refunds');
}));
r.post('/admin/refunds/recheck', needStaff('settlement'), h(async (req, res) => { await refunds.tick(); res.flash('재확인했습니다'); res.back('/admin/refunds'); }));
r.post('/admin/refunds/:id/manual', needStaff('settlement'), h(async (req, res) => { refunds.recordManual(req.user, int(req.params.id), { done: req.body.done === '1', note: req.body.note }); res.flash('기록했습니다'); res.back('/admin/refunds'); }));

// ── 대사
r.get('/admin/reconcile', needStaff('settlement'), (req, res) => {
  const rows = q.all("SELECT i.*, o.order_no FROM reconciliation_issues i LEFT JOIN orders o ON o.id = i.order_id ORDER BY CASE i.status WHEN 'open' THEN 0 ELSE 1 END, i.id DESC LIMIT 300");
  const KIND = { amount_mismatch: '결제 금액 불일치', refund_mismatch: '환불액 불일치', payout_mismatch: '지급액 불일치', released_during_dispute: '분쟁 중 외부 지급됨', protection_mismatch: '대금 보호 상태 불일치', auto_confirm_before_inspection: '외부 자동확정이 검수 종료보다 빠름', ledger_unbalanced: '원장 묶음 불균형', seller_payable_negative: '판매자 지급 잔액 음수', ledger_holding_mismatch: '원장 보유액 불일치', provider_unreachable: '사업자 조회 실패', manual_refund_review: '수동 환불 — 사업자 장부 확인 필요' };
  page(req, res, '대사', html`${head('대사', '플랫폼 내부 상태와 결제 사업자 상태, 원장 불변식을 비교합니다', postBtn(req, '/admin/reconcile/run', '대사 실행', { cls: 'primary' }))}
    ${rows.length ? rows.map((i) => card('', html`<p>${tag(i.status === 'open' ? '미해소' : '해소', i.status === 'open' ? 'bad' : '')} <b>${KIND[i.kind] || i.kind}</b> ${i.order_id ? html`<a href="/admin/orders/${i.order_id}">${i.order_no}</a>` : ''} <span class="muted"><code>${i.ref}</code> · 최초 ${fmtDate(i.first_seen_at)} · 최근 ${fmtDate(i.last_seen_at)}</span></p>
      ${dl([['내부 값', i.internal_value], ['외부 값', i.external_value], i.note && ['메모', i.note]])}
      ${i.status === 'open' ? html`<form method="post" action="/admin/reconcile/${i.id}/resolve" class="row">${csrf(req)}${field('확인 내용', 'note', '', { required: true })}<div class="field"><label>&nbsp;</label><button class="btn sm">해소 처리</button></div></form>` : ''}`)) : html`<p class="empty">기록된 불일치가 없습니다</p>`}`);
});
r.post('/admin/reconcile/run', needStaff('settlement'), h(async (req, res) => {
  const out = await reconcile.run();
  audit(req.user, 'reconcile.run', '', '', { checked: out.checked, recovered: out.recovered, issues: out.issues.length }, req.ip);
  res.flash(`결제 ${out.checked}건 비교 · 누락 결제 ${out.recovered}건 복구 · 불일치 ${out.issues.length}건`, out.issues.length ? 'error' : 'ok'); res.back('/admin/reconcile');
}));
r.post('/admin/reconcile/:id/resolve', needStaff('settlement'), h(async (req, res) => {
  const i = q.get("SELECT * FROM reconciliation_issues WHERE id = ? AND status = 'open'", int(req.params.id));
  must(i, '미해소 항목이 아닙니다.', 409);
  must(str(req.body.note).length >= 5, '확인 내용을 적어 주세요.');
  q.update('reconciliation_issues', i.id, { status: 'resolved', note: str(req.body.note, 1000), resolved_by: req.user.id, resolved_at: clock.iso() });
  audit(req.user, 'reconcile.resolve', 'reconciliation_issue', i.id, { note: str(req.body.note, 1000) }, req.ip);
  res.flash('해소 처리했습니다. 다음 대사에서 다시 보이면 새로 기록됩니다'); res.back('/admin/reconcile');
}));

// ── 수수료 정책
r.get('/admin/fees', needStaff('settlement'), (req, res) => {
  const now = clock.iso();
  const rows = q.all('SELECT * FROM fee_policies ORDER BY id DESC');
  const cats = q.all('SELECT * FROM categories ORDER BY sort');
  const scopeLabel = (p) => (p.scope === 'default' ? '기본' : p.scope === 'category' ? `카테고리: ${cats.find((c) => c.id === p.scope_id)?.name || p.scope_id}` : `판매자: ${q.get('SELECT display_name FROM seller_profiles WHERE user_id = ?', p.scope_id)?.display_name || '#' + p.scope_id}`);
  const state = (p) => (p.ends_at && p.ends_at <= now ? tag('종료') : p.starts_at && p.starts_at > now ? tag('시작 전', 'warn') : tag('적용 중', 'ok'));
  let example = '';
  if (req.query.amount) {
    try { const a = toWon(req.query.amount); const qt = fees.quote(a, int(req.query.seller) || null, int(req.query.category) || null);
      example = dl([['결제액', won(a)], ['적용 정책', `${qt.fee_policy_label} (${bpsPct(qt.fee_bps)})`], ['플랫폼 수수료', html`${won(qt.fee_amount)} <span class="muted">부가세 ${won(qt.fee_vat)} 포함</span>`], ['결제 비용(추정)', `${won(qt.pg_fee_amount)} · ${qt.pg_fee_bearer === 'seller' ? '판매자 부담' : '플랫폼 부담'}`], ['판매자 예상 정산액', won(qt.seller_net)]]);
    } catch (e) { example = notice(e.message, 'bad'); }
  }
  page(req, res, '수수료 정책', html`${head('수수료 정책', '판매자별 > 카테고리별 > 기본 순으로 적용하고, 같은 범위에서는 기간 한정 정책이 우선합니다')}
    ${notice('기존 주문에는 주문 시점의 수수료율이 고정되어 있어 정책을 바꿔도 영향이 없습니다. 정책은 삭제하지 않고 종료 처리합니다')}
    ${card('정책 목록', table(['#', '범위', '수수료율', '이름', '기간', '상태', ''], rows.map((p) => [p.id, scopeLabel(p), bpsPct(p.rate_bps), p.label || '-', `${p.starts_at ? fmtDate(p.starts_at, false) : '상시'} ~ ${p.ends_at ? fmtDate(p.ends_at, false) : ''}`, state(p), !p.ends_at || p.ends_at > now ? postBtn(req, `/admin/fees/${p.id}/end`, '종료', { cls: 'sm' }) : ''])))}
    ${card('정책 추가', html`<form method="post" action="/admin/fees">${csrf(req)}
      <div class="row">${field('범위', 'scope', 'default', { options: [['default', '기본'], ['category', '카테고리별'], ['seller', '판매자별']] })}${field('카테고리', 'category_id', '', { options: [['', '해당 없음'], ...cats.map((c) => [c.id, c.name])] })}${field('판매자 회원 번호', 'seller_id', '', { hint: '판매자별일 때' })}</div>
      <div class="row">${field('수수료율(%)', 'rate', '', { required: true, hint: '0~50, 소수 둘째 자리까지' })}${field('이름', 'label', '', { placeholder: '예: 신규 입점 할인' })}${field('시작일', 'starts_at', '', { type: 'date', hint: '비우면 즉시' })}${field('종료일', 'ends_at', '', { type: 'date', hint: '할인 기간. 비우면 상시' })}</div>
      <button class="btn primary">추가</button></form>`)}
    ${card('적용 예시 계산', html`<form method="get" class="row"><div class="field"><label>결제액(원)</label><input name="amount" value="${req.query.amount || ''}"></div><div class="field"><label>카테고리</label><select name="category"><option value="">없음</option>${cats.map((c) => html`<option value="${c.id}" ${String(c.id) === req.query.category ? ui.raw('selected') : ''}>${c.name}</option>`)}</select></div><div class="field"><label>판매자 회원 번호</label><input name="seller" value="${req.query.seller || ''}"></div><div class="field"><label>&nbsp;</label><button class="btn sm">계산</button></div></form>${example}`)}`);
});
const dayIso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? new Date(s + 'T00:00:00+09:00').toISOString() : null);
r.post('/admin/fees', needStaff('settlement'), h(async (req, res) => {
  const scope = ['default', 'category', 'seller'].includes(req.body.scope) ? req.body.scope : 'default';
  const rate = Number(req.body.rate);
  must(Number.isFinite(rate) && rate >= 0 && rate <= 50 && String(req.body.rate).trim() !== '', '수수료율은 0~50% 사이로 입력하세요.');
  let scopeId = null;
  if (scope === 'category') { scopeId = q.get('SELECT id FROM categories WHERE id = ?', int(req.body.category_id))?.id; must(scopeId, '카테고리를 선택하세요.'); }
  if (scope === 'seller') { scopeId = q.get('SELECT user_id FROM seller_profiles WHERE user_id = ?', int(req.body.seller_id))?.user_id; must(scopeId, '판매자 회원 번호를 확인하세요.'); }
  const starts = dayIso(req.body.starts_at), ends = dayIso(req.body.ends_at);
  must(!ends || !starts || ends > starts, '종료일은 시작일 이후여야 합니다.');
  const id = q.insert('fee_policies', { scope, scope_id: scopeId, rate_bps: Math.round(rate * 100), label: str(req.body.label, 80), starts_at: starts, ends_at: ends, created_by: req.user.id, created_at: clock.iso() });
  audit(req.user, 'fee_policy.create', 'fee_policy', id, { scope, scopeId, rate_bps: Math.round(rate * 100), starts, ends }, req.ip);
  res.flash('정책을 추가했습니다. 이후 생성되는 주문부터 적용됩니다'); res.back('/admin/fees');
}));
r.post('/admin/fees/:id/end', needStaff('settlement'), h(async (req, res) => {
  const p = q.get('SELECT * FROM fee_policies WHERE id = ?', int(req.params.id));
  must(p, '정책을 찾을 수 없습니다.', 404);
  if (p.scope === 'default') must(q.get("SELECT COUNT(*) c FROM fee_policies WHERE scope = 'default' AND id <> ? AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?)", p.id, clock.iso(), clock.iso()).c > 0, '적용 중인 다른 기본 수수료 정책이 있어야 종료할 수 있습니다.', 409);
  q.update('fee_policies', p.id, { ends_at: clock.iso() });
  audit(req.user, 'fee_policy.end', 'fee_policy', p.id, {}, req.ip);
  res.flash('정책을 종료했습니다'); res.back('/admin/fees');
}));

// ── 결제 사업자 확인표(최고관리자)
r.get('/admin/pg', needStaff('super'), (req, res) => {
  const p = providers.active();
  const d = p.declared(), caps = providers.caps();
  const rows = Object.fromEntries(q.all('SELECT * FROM pg_capability_checks WHERE provider = ?', p.name).map((x) => [x.item, x]));
  const show = (v) => (v === null || v === undefined ? '밝히지 않음(계약 확인 필요)' : v === true ? '지원' : v === false ? '미지원' : Array.isArray(v) ? v.join(', ') || '없음' : String(v));
  const ST = { unverified: ['미확인', 'warn'], supported: ['지원 확인', 'ok'], unsupported: ['미지원 확인', 'bad'] };
  const requiredOk = providers.CHECK_ITEMS.filter(([, , req2]) => req2).every(([k]) => rows[k]?.status === 'supported');
  const live = q.setting('live_mode') === '1';
  const capRows = [['결제 받기', caps.checkout_enabled], ['사업자 대금 보류', caps.escrow_hold], ['분쟁 시 외부 지급 중지', caps.dispute_hold], ['단계별 결제', caps.staged_payments], ['판매자 지급 API', caps.payout_api], ['지급 후 환불', caps.refund_after_payout]];
  page(req, res, '결제 사업자 확인표', html`${head('결제 사업자 확인표', `현재 사업자: ${p.name} (${p.mode === 'test' ? '테스트' : '실결제'})`)}
    ${p.mode === 'test' ? notice('테스트 사업자입니다. 실제 보호·지급이 이루어지지 않으며 아래 기능 값은 플랫폼 로직 검증을 위한 시뮬레이션입니다. 확인표는 실결제 사업자로 전환했을 때 적용됩니다', 'warn') : notice('확인표에 지원으로 기록한 항목만 켜집니다. 계약서, 사업자 문서, 담당자 회신 등 근거를 함께 남기세요. 확인되지 않은 기능은 대체 절차 또는 미지원으로 표시됩니다')}
    ${card('실제 활성화되는 기능', html`${table(['기능', '상태'], [...capRows.map(([l, v]) => [l, v ? tag('활성', 'ok') : tag('비활성 — 대체 절차 또는 미지원')]),
      ['최대 보류 기간', caps.max_hold_days != null ? `${caps.max_hold_days}일` : '확인되지 않음'], ['사업자 자동확정', caps.auto_confirm_days ? `${caps.auto_confirm_days}일 후` : '없음 또는 확인되지 않음'],
      ['결제수단', (caps.methods || []).join(', ') || '확인되지 않음'], ['부분 환불 가능 수단', (caps.partial_refund_methods || []).join(', ') || '없음(부분 환불은 수동 절차)']])}`)}
    ${providers.CHECK_ITEMS.map(([k, l, required]) => { const x = rows[k] || { status: 'unverified', value: '', evidence: '' }; return card('', html`
      <p><b>${l}</b> ${required ? tag('실결제 필수') : ''} ${tag(...ST[x.status])} <span class="muted">사업자 어댑터가 밝힌 값: ${show(d[k])}${x.checked_at ? ` · ${userName(x.checked_by)} ${fmtDate(x.checked_at)}` : ''}</span></p>
      <form method="post" action="/admin/pg/${k}">${csrf(req)}<div class="row">${field('확인 결과', 'status', x.status, { options: [['unverified', '미확인'], ['supported', '지원 확인'], ['unsupported', '미지원 확인']] })}${field('값', 'value', x.value, { hint: '일수, 결제수단 목록(card,transfer,vbank) 등' })}</div>
      ${field('근거', 'evidence', x.evidence, { rows: 2, hint: '계약 조항, 문서 주소, 담당자 회신 일자 등' })}<button class="btn sm">저장</button></form>`); })}
    ${card('실결제 모드', html`<p class="sub">현재 ${live ? '켜짐' : '꺼짐'}. 필수 확인 항목이 모두 지원으로 확인되어야 켤 수 있습니다${p.mode === 'test' ? '. 테스트 사업자에서는 이 설정과 무관하게 테스트 결제만 진행됩니다' : ''}</p>
      ${live ? postBtn(req, '/admin/pg-live', '실결제 모드 끄기', { cls: 'danger', fields: { on: '0' } }) : requiredOk ? html`<form method="post" action="/admin/pg-live">${csrf(req)}<input type="hidden" name="on" value="1">${check('사업자 계약, 정책·법률 검토, 테스트 키 점검 절차를 마쳤습니다', 'confirm', false, { required: true })}<button class="btn primary">실결제 모드 켜기</button></form>` : notice('필수 확인 항목이 완료되지 않았습니다', 'warn')}`)}`);
});
r.post('/admin/pg/:item', needStaff('super'), h(async (req, res) => {
  const p = providers.active();
  must(providers.CHECK_ITEMS.some(([k]) => k === req.params.item), '알 수 없는 항목입니다.', 404);
  const status = ['unverified', 'supported', 'unsupported'].includes(req.body.status) ? req.body.status : 'unverified';
  if (status !== 'unverified') must(str(req.body.evidence).length >= 5, '확인 근거를 적어 주세요.');
  q.run(`INSERT INTO pg_capability_checks (provider, item, status, value, evidence, checked_by, checked_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(provider, item) DO UPDATE SET status = excluded.status, value = excluded.value, evidence = excluded.evidence, checked_by = excluded.checked_by, checked_at = excluded.checked_at`,
    p.name, req.params.item, status, str(req.body.value, 200), str(req.body.evidence, 2000), req.user.id, clock.iso());
  audit(req.user, 'pg_check.update', 'pg_capability', `${p.name}:${req.params.item}`, { status, value: str(req.body.value, 200) }, req.ip);
  // 필수 항목이 더 이상 확인 상태가 아니면 실결제 모드를 끈다.
  const rows = Object.fromEntries(q.all('SELECT * FROM pg_capability_checks WHERE provider = ?', p.name).map((x) => [x.item, x]));
  if (q.setting('live_mode') === '1' && !providers.CHECK_ITEMS.filter(([, , rq]) => rq).every(([k]) => rows[k]?.status === 'supported')) {
    q.run("UPDATE settings SET value = '0', updated_by = ?, updated_at = ? WHERE key = 'live_mode'", req.user.id, clock.iso());
    audit(req.user, 'settings.update', 'setting', 'live_mode', { from: '1', to: '0', reason: '필수 확인 항목 미충족' }, req.ip);
  }
  res.flash('저장했습니다'); res.back('/admin/pg');
}));
r.post('/admin/pg-live', needStaff('super'), h(async (req, res) => {
  const p = providers.active(), on = req.body.on === '1';
  if (on) {
    const rows = Object.fromEntries(q.all('SELECT * FROM pg_capability_checks WHERE provider = ?', p.name).map((x) => [x.item, x]));
    must(providers.CHECK_ITEMS.filter(([, , rq]) => rq).every(([k]) => rows[k]?.status === 'supported'), '필수 확인 항목이 완료되지 않아 실결제 모드를 켤 수 없습니다.', 409);
    must(req.body.confirm === '1', '확인란에 체크하세요.');
  }
  const from = q.setting('live_mode');
  q.run("UPDATE settings SET value = ?, updated_by = ?, updated_at = ? WHERE key = 'live_mode'", on ? '1' : '0', req.user.id, clock.iso());
  audit(req.user, 'settings.update', 'setting', 'live_mode', { from, to: on ? '1' : '0' }, req.ip);
  res.flash(on ? '실결제 모드를 켰습니다' : '실결제 모드를 껐습니다'); res.back('/admin/pg');
}));

// ── 운영 설정(최고관리자)
const SETTINGS = [
  ['pg_fee_bps', '결제 비용 추정치(bps, 330 = 3.3%)', 'int', [0, 2000], '실제 값은 사업자 정산 자료로 대사합니다'],
  ['pg_fee_bearer', '결제 비용 부담 주체', [['platform', '플랫폼'], ['seller', '판매자']]],
  ['settlement_cycle', '정산 주기', [['on_confirm', '구매확정 시'], ['weekly', '주 1회(월요일)']]],
  ['dispute_buffer_days', '분쟁 여유일', 'int', [0, 30], '납품 기한+검수 기간+이 값이 사업자 보류 기간을 넘는 상품은 결제가 막힙니다'],
  ['auto_confirm_enabled', '검수 기한 경과 시 자동확정', [['0', '끄기 — 판매자가 검수 종료 심사를 요청'], ['1', '켜기']]],
  ['appeal_days', '이의제기 기간(일)', 'int', [0, 30]],
  ['bank_change_hold_hours', '정산 계좌 변경 후 지급 보류(시간)', 'int', [0, 720]],
  ['high_value_threshold', '고액 거래 기준(원)', 'int', [0, 100000000000]],
  ['retention_days', '판매자 삭제·탈퇴 후 납품물 보관 기간(일)', 'int', [30, 36500]],
  ['download_link_minutes', '다운로드 링크 유효 시간(분)', 'int', [1, 120]],
  ['require_malware_scan', '악성 파일 검사 통과 필수', [['0', '끄기 — 검사 불가 파일도 심사 가능(상태는 그대로 표시)'], ['1', '켜기 — 검사 불가 파일은 판매 승인 불가']]],
];
r.get('/admin/settings', needStaff('super'), (req, res) => {
  page(req, res, '운영 설정', html`${head('운영 설정', '변경 내용은 감사 기록에 남고 이후 생성되는 주문부터 적용됩니다')}
    ${card('', html`<form method="post" action="/admin/settings">${csrf(req)}
      ${SETTINGS.map(([k, l, type, range, hint]) => field(l, k, q.setting(k), Array.isArray(type) ? { options: type } : { type: 'number', hint: hint || '', attrs: `min="${range[0]}" max="${range[1]}"` }))}
      ${check('자동확정을 켜는 경우: 결제 사업자의 자동확정·보류 정책과 운영 정책(약관 고지 포함) 검토를 마쳤습니다', 'auto_confirm_reviewed', false)}
      <button class="btn primary">저장</button></form>`)}`);
});
r.post('/admin/settings', needStaff('super'), h(async (req, res) => {
  const changes = [];
  for (const [k, l, type, range] of SETTINGS) {
    if (req.body[k] === undefined) continue;
    let v = String(req.body[k]).trim();
    if (Array.isArray(type)) must(type.some(([o]) => o === v), `${l}: 선택 값이 올바르지 않습니다.`);
    else { must(/^\d{1,12}$/.test(v), `${l}: 숫자로 입력하세요.`); must(Number(v) >= range[0] && Number(v) <= range[1], `${l}: ${range[0]}~${range[1]} 범위로 입력하세요.`); v = String(Number(v)); }
    const cur = q.setting(k);
    if (cur !== v) changes.push([k, cur, v]);
  }
  if (changes.some(([k, , v]) => k === 'auto_confirm_enabled' && v === '1')) must(req.body.auto_confirm_reviewed === '1', '자동확정을 켜려면 결제 사업자 정책 및 운영 정책 검토 완료를 확인해야 합니다.');
  q.tx(() => { for (const [k, from, to] of changes) {
    q.run('INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at', k, to, req.user.id, clock.iso());
    audit(req.user, 'settings.update', 'setting', k, { from, to }, req.ip);
  } });
  res.flash(changes.length ? `${changes.length}개 설정을 변경했습니다` : '변경된 설정이 없습니다'); res.back('/admin/settings');
}));

// ── 운영자 권한 · 회원 정지(최고관리자)
r.get('/admin/staff', needStaff('super'), (req, res) => {
  const staff = q.all('SELECT s.*, u.email, u.name, u.totp_enabled FROM staff_roles s JOIN users u ON u.id = s.user_id ORDER BY u.email, s.role');
  const found = req.query.email ? q.get('SELECT id, email, name, status, created_at FROM users WHERE email = ?', str(req.query.email, 200)) : null;
  const suspended = q.all("SELECT id, email, name FROM users WHERE status = 'suspended' ORDER BY id DESC LIMIT 100");
  page(req, res, '운영자 권한', html`${head('운영자 권한', '권한은 업무에 필요한 만큼만 부여하세요. 부여·회수는 감사 기록에 남습니다')}
    ${card('운영자', html`${table(['이메일', '이름', '권한', '추가 인증', '부여', ''], staff.map((s) => [s.email, s.name, STAFF_ROLES[s.role], s.totp_enabled ? tag('등록됨', 'ok') : tag('미등록', 'warn'), `${fmtDate(s.granted_at, false)} ${s.granted_by ? userName(s.granted_by) : ''}`, postBtn(req, '/admin/staff/revoke', '회수', { cls: 'sm danger', fields: { user_id: s.user_id, role: s.role } })]))}
      <form method="post" action="/admin/staff/grant" class="row mt">${csrf(req)}${field('회원 이메일', 'email', '', { type: 'email', required: true })}${field('권한', 'role', '', { options: Object.entries(STAFF_ROLES) })}<div class="field"><label>&nbsp;</label><button class="btn">권한 부여</button></div></form>`)}
    ${card('회원 정지·해제', html`<form method="get" class="row"><div class="field"><label>회원 이메일</label><input type="email" name="email" value="${req.query.email || ''}"></div><div class="field"><label>&nbsp;</label><button class="btn sm">찾기</button></div></form>
      ${req.query.email ? (found ? html`<p>${found.name} · ${found.email} · 가입 ${fmtDate(found.created_at, false)} · ${found.status === 'active' ? tag('정상', 'ok') : tag(found.status === 'suspended' ? '정지' : '탈퇴', 'bad')}</p>
        ${found.status === 'withdrawn' ? '' : html`<form method="post" action="/admin/users/${found.id}/status">${csrf(req)}<input type="hidden" name="status" value="${found.status === 'active' ? 'suspended' : 'active'}">${field('사유', 'reason', '', { required: true })}<button class="btn sm ${found.status === 'active' ? 'danger' : ''}">${found.status === 'active' ? '회원 정지' : '정지 해제'}</button></form>`}` : html`<p class="muted">해당 이메일의 회원이 없습니다</p>`) : ''}
      ${suspended.length ? html`<h3>정지된 회원</h3>${table(['이메일', '이름', ''], suspended.map((u) => [u.email, u.name, html`<a href="?email=${encodeURIComponent(u.email)}">열기</a>`]))}` : ''}
      <p class="hint">정지된 회원은 로그인할 수 없습니다. 진행 중인 주문의 접근 권한, 분쟁, 정산 기록은 그대로 유지됩니다</p>`)}`);
});
r.post('/admin/staff/grant', needStaff('super'), h(async (req, res) => {
  const u = q.get("SELECT id FROM users WHERE email = ? AND status = 'active'", str(req.body.email, 200));
  must(u, '해당 이메일의 활성 회원이 없습니다.', 404);
  must(STAFF_ROLES[req.body.role], '권한을 선택하세요.');
  q.run('INSERT OR IGNORE INTO staff_roles (user_id, role, granted_by, granted_at) VALUES (?,?,?,?)', u.id, req.body.role, req.user.id, clock.iso());
  audit(req.user, 'staff.grant', 'user', u.id, { role: req.body.role }, req.ip);
  notify(u.id, '운영자 권한이 부여되었습니다', STAFF_ROLES[req.body.role], '/admin');
  res.flash('권한을 부여했습니다'); res.back('/admin/staff');
}));
r.post('/admin/staff/revoke', needStaff('super'), h(async (req, res) => {
  const uid = int(req.body.user_id);
  if (req.body.role === 'super') must(q.get("SELECT COUNT(*) c FROM staff_roles WHERE role = 'super' AND user_id <> ?", uid).c > 0, '마지막 최고관리자 권한은 회수할 수 없습니다.', 409);
  const n = q.run('DELETE FROM staff_roles WHERE user_id = ? AND role = ?', uid, String(req.body.role)).changes;
  must(n, '해당 권한이 없습니다.', 404);
  audit(req.user, 'staff.revoke', 'user', uid, { role: req.body.role }, req.ip);
  res.flash('권한을 회수했습니다'); res.back('/admin/staff');
}));
r.post('/admin/users/:id/status', needStaff('super'), h(async (req, res) => {
  const u = q.get('SELECT * FROM users WHERE id = ?', int(req.params.id));
  must(u && u.status !== 'withdrawn', '회원을 찾을 수 없습니다.', 404);
  must(u.id !== req.user.id, '자신의 계정은 정지할 수 없습니다.', 409);
  const status = req.body.status === 'suspended' ? 'suspended' : 'active';
  must(str(req.body.reason).length >= 5, '사유를 적어 주세요.');
  q.update('users', u.id, { status });
  if (status === 'suspended') q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  audit(req.user, 'user.status', 'user', u.id, { status, reason: str(req.body.reason, 500) }, req.ip);
  res.flash(status === 'suspended' ? '회원을 정지했습니다' : '정지를 해제했습니다'); res.back('/admin/staff');
}));

// ── 신고·권리 침해
const REPORT_KIND = { rights_infringement: '권리 침해', malware: '악성 파일', fraud: '사기 의심', redistribution: '무단 재배포·재판매', fake_review: '허위 후기', other: '기타' };
const REPORT_ST = { open: ['접수', 'warn'], reviewing: ['검토 중', 'warn'], actioned: ['조치함', 'ok'], dismissed: ['기각', ''] };
const targetLink = (t, id) => ({ product: html`<a href="/admin/products/${id}">상품 #${id}</a>`, order: html`<a href="/admin/orders/${id}">주문 #${id}</a>`, ip_listing: html`<a href="/ip/${id}">권리 매물 #${id}</a>`, review: html`<a href="/admin/reviews">후기 #${id}</a>`, user: html`회원 #${id}` }[t]);
r.get('/admin/reports', needStaff('support', 'review'), (req, res) => {
  const rows = q.all("SELECT r.*, u.name FROM reports r JOIN users u ON u.id = r.reporter_id ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END, r.id DESC LIMIT 300");
  page(req, res, '신고·권리 침해', html`${head('신고·권리 침해', '권리 침해 여부의 최종 판단은 플랫폼이 하지 않습니다. 자료를 확인하고 판매 제한 등 가능한 조치를 기록합니다', html`<a class="btn sm" href="/admin/reviews">후기 관리</a>`)}
    ${rows.length ? rows.map((x) => { const blocked = x.target_type === 'product' ? q.get('SELECT sales_blocked FROM products WHERE id = ?', x.target_id)?.sales_blocked : null; return card('', html`
      <p>${tag(...REPORT_ST[x.status])} <b>${REPORT_KIND[x.kind]}</b> · ${targetLink(x.target_type, x.target_id)} <span class="muted">신고자 ${x.name} · ${fmtDate(x.created_at)}</span></p><p>${nl2br(x.body)}</p>
      ${x.action_note ? html`<p class="sub">조치 메모: ${x.action_note} (${userName(x.handled_by)}, ${fmtDate(x.handled_at)})</p>` : ''}
      ${x.target_type === 'product' && blocked === 0 ? html`<form method="post" action="/admin/products/${x.target_id}/block" class="row">${csrf(req)}<input type="hidden" name="blocked" value="1">${field('판매 제한 사유', 'reason', `${REPORT_KIND[x.kind]} 신고 #${x.id} 검토`)}<div class="field"><label>&nbsp;</label><button class="btn sm danger">이 상품 신규 판매 제한</button></div></form>` : ''}
      ${x.target_type === 'product' && blocked === 1 ? html`<p>${tag('신규 판매 제한 중', 'bad')}</p>` : ''}
      ${['open', 'reviewing'].includes(x.status) ? html`<form method="post" action="/admin/reports/${x.id}" class="row">${csrf(req)}${field('상태', 'status', x.status === 'open' ? 'reviewing' : 'actioned', { options: [['reviewing', '검토 중'], ['actioned', '조치함'], ['dismissed', '기각']] })}${field('조치 메모', 'action_note', '', { required: true })}<div class="field"><label>&nbsp;</label><button class="btn sm">저장</button></div></form>` : ''}`); }) : html`<p class="empty">신고가 없습니다</p>`}`);
});
r.post('/admin/reports/:id', needStaff('support', 'review'), h(async (req, res) => {
  const x = q.get('SELECT * FROM reports WHERE id = ?', int(req.params.id));
  must(x, '신고를 찾을 수 없습니다.', 404);
  must(['reviewing', 'actioned', 'dismissed'].includes(req.body.status), '상태를 선택하세요.');
  must(str(req.body.action_note).length >= 5, '조치 메모를 적어 주세요.');
  q.update('reports', x.id, { status: req.body.status, action_note: str(req.body.action_note, 1000), handled_by: req.user.id, handled_at: clock.iso() });
  audit(req.user, 'report.handle', 'report', x.id, { status: req.body.status, note: str(req.body.action_note, 1000) }, req.ip);
  if (req.body.status !== 'reviewing') notify(x.reporter_id, `신고 처리 결과: ${REPORT_ST[req.body.status][0]}`, str(req.body.action_note, 300), '/support');
  res.flash('저장했습니다'); res.back('/admin/reports');
}));

// ── 후기 관리(허위 후기 대응)
r.get('/admin/reviews', needStaff('support', 'review'), (req, res) => {
  const rows = q.all('SELECT r.*, o.order_no, u.name, p.title FROM reviews r JOIN orders o ON o.id = r.order_id JOIN users u ON u.id = r.buyer_id LEFT JOIN products p ON p.id = r.product_id ORDER BY r.id DESC LIMIT 300');
  page(req, res, '후기 관리', html`${head('후기 관리', '후기는 검수를 마친 실제 구매자만 작성할 수 있습니다. 숨김 처리는 사유와 함께 기록됩니다')}
    ${rows.length ? rows.map((x) => card('', html`<p>${x.hidden ? tag('숨김', 'bad') : tag('공개', 'ok')} 평점 ${x.rating} · ${x.title || '-'} · <a href="/admin/orders/${x.order_id}">${x.order_no}</a> <span class="muted">${x.name} · ${fmtDate(x.created_at)}</span></p><p>${nl2br(x.body)}</p>
      ${x.hidden ? html`<p class="sub">숨김 사유: ${x.hidden_reason}</p>` : ''}
      <form method="post" action="/admin/reviews/${x.id}" class="row">${csrf(req)}<input type="hidden" name="hidden" value="${x.hidden ? '0' : '1'}">${field('사유', 'reason', '', { required: true })}<div class="field"><label>&nbsp;</label><button class="btn sm ${x.hidden ? '' : 'danger'}">${x.hidden ? '다시 공개' : '숨김 처리'}</button></div></form>`)) : html`<p class="empty">후기가 없습니다</p>`}`);
});
r.post('/admin/reviews/:id', needStaff('support', 'review'), h(async (req, res) => {
  const x = q.get('SELECT * FROM reviews WHERE id = ?', int(req.params.id));
  must(x, '후기를 찾을 수 없습니다.', 404);
  must(str(req.body.reason).length >= 5, '사유를 적어 주세요.');
  const hidden = req.body.hidden === '1' ? 1 : 0;
  q.update('reviews', x.id, { hidden, hidden_reason: hidden ? str(req.body.reason, 500) : '' });
  audit(req.user, hidden ? 'review.hide' : 'review.unhide', 'review', x.id, { reason: str(req.body.reason, 500) }, req.ip);
  if (hidden) notify(x.buyer_id, '작성한 후기가 숨김 처리되었습니다', str(req.body.reason, 300), `/my/orders/${x.order_id}`);
  res.flash('처리했습니다'); res.back('/admin/reviews');
}));

// ── 지원 티켓
const TK = { open: ['답변 대기', 'warn'], answered: ['답변함', 'ok'], closed: ['종료', ''] };
r.get('/admin/tickets', needStaff('support'), (req, res) => {
  const rows = q.all("SELECT t.*, u.name, u.email FROM tickets t JOIN users u ON u.id = t.user_id ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END, t.updated_at DESC LIMIT 300");
  page(req, res, '지원 티켓', html`${head('지원 티켓')}${table(['상태', '제목', '회원', '분류', '관련 주문', '최근'], rows.map((t) => [tag(...TK[t.status]), html`<a href="/admin/tickets/${t.id}">${t.subject}</a>`, `${t.name} (${t.email})`, t.category, t.order_id ? html`<a href="/admin/orders/${t.order_id}">#${t.order_id}</a>` : '-', fmtDate(t.updated_at)]), '티켓이 없습니다')}`);
});
r.get('/admin/tickets/:id', needStaff('support'), (req, res) => {
  const t = q.get('SELECT t.*, u.name, u.email FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?', int(req.params.id));
  if (!t) throw notFound();
  const ms = q.all('SELECT m.*, u.name FROM ticket_messages m JOIN users u ON u.id = m.user_id WHERE m.ticket_id = ? ORDER BY m.id', t.id);
  page(req, res, t.subject, html`${head(t.subject, `${t.name} (${t.email}) · ${t.category}${t.order_id ? ` · 주문 #${t.order_id}` : ''} · ${fmtDate(t.created_at)}`, tag(...TK[t.status]))}
    ${card('대화', html`<div class="thread">${ms.map((m) => html`<div class="msg ${m.is_staff ? 'me' : ''}"><div class="who">${m.is_staff ? '운영자 ' : ''}${m.name} · ${fmtDate(m.created_at)}</div>${nl2br(m.body)}</div>`)}</div>
      ${t.order_id ? html`<p><a href="/admin/orders/${t.order_id}">관련 주문 열기</a></p>` : ''}
      <form method="post" action="/admin/tickets/${t.id}">${csrf(req)}${field('답변', 'body', '', { rows: 4 })}${field('처리 후 상태', 'status', 'answered', { options: [['answered', '답변함'], ['closed', '종료'], ['open', '답변 대기로 유지']] })}<button class="btn primary">저장</button></form>`)}`);
});
r.post('/admin/tickets/:id', needStaff('support'), h(async (req, res) => {
  const t = q.get('SELECT * FROM tickets WHERE id = ?', int(req.params.id));
  must(t, '티켓을 찾을 수 없습니다.', 404);
  const status = ['open', 'answered', 'closed'].includes(req.body.status) ? req.body.status : 'answered';
  const body = str(req.body.body, 5000);
  must(body.length >= 2 || status === 'closed', '답변 내용을 입력하세요.');
  if (body) q.insert('ticket_messages', { ticket_id: t.id, user_id: req.user.id, is_staff: 1, body, created_at: clock.iso() });
  q.update('tickets', t.id, { status, updated_at: clock.iso() });
  audit(req.user, 'ticket.reply', 'ticket', t.id, { status }, req.ip);
  notify(t.user_id, status === 'closed' ? '문의가 종료되었습니다' : '문의에 답변이 등록되었습니다', t.subject, `/support/tickets/${t.id}`);
  res.flash('저장했습니다'); res.back('/admin/tickets');
}));

// ── 감사 기록(최고관리자)
r.get('/admin/audit', needStaff('super'), (req, res) => {
  const where = ['1=1'], args = [];
  if (req.query.action) { where.push('a.action LIKE ?'); args.push(`${str(req.query.action, 60)}%`); }
  if (req.query.actor) { where.push('(u.email LIKE ? OR u.name LIKE ?)'); const k = `%${str(req.query.actor, 60)}%`; args.push(k, k); }
  const from = dayIso(req.query.from), to = dayIso(req.query.to);
  if (from) { where.push('a.created_at >= ?'); args.push(from); }
  if (to) { where.push('a.created_at < ?'); args.push(new Date(new Date(to).getTime() + 86400000).toISOString()); }
  const rows = q.all(`SELECT a.*, u.name, u.email FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT 500`, ...args);
  page(req, res, '감사 기록', html`${head('감사 기록', '추가만 가능한 기록입니다. 수정·삭제는 DB 차원에서 막혀 있습니다 · 최근 500건')}
    <form class="filters" method="get"><input name="action" value="${req.query.action || ''}" placeholder="동작(예: payout, dispute.resolve)"><input name="actor" value="${req.query.actor || ''}" placeholder="처리자 이름·이메일"><input type="date" name="from" value="${req.query.from || ''}"><input type="date" name="to" value="${req.query.to || ''}"><button class="btn sm">조회</button></form>
    ${table(['일시', '처리자', '권한', '동작', '대상', '내용', 'IP'], rows.map((a) => [fmtDate(a.created_at), a.actor_id ? `${a.name || ''} ${a.email || ''}` : '시스템', a.actor_role, html`<code>${a.action}</code>`, `${a.target_type} ${a.target_id}`, html`<code>${a.detail === '{}' ? '' : a.detail.slice(0, 300)}</code>`, a.ip || '-']), '기록이 없습니다')}`);
});

module.exports = r;
