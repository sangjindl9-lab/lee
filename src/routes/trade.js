'use strict';
// 주문 · 결제 · 다운로드 · 검수 (구매자·판매자 거래 작업실)
const r = require('express').Router();
const { q } = require('../db');
const { h, needUser, receiveFile } = require('../web');
const ui = require('../ui');
const { html, csrf, field, check, card, notice, badge, tag, won, fmtDate, table, postBtn, nl2br, hashChip } = ui;
const { must, int, str, AppError } = require('../util');
const orders = require('../services/orders');
const access = require('../services/access');
const inspection = require('../services/inspection');
const deliveries = require('../services/deliveries');
const disputes = require('../services/disputes');
const refunds = require('../services/refunds');
const messages = require('../services/messages');
const providers = require('../providers');
const storage = require('../storage');
const V = require('../views/order');

// ── 주문 생성 → 조건 확인 → 결제
r.post('/orders', needUser, h(async (req, res) => {
  const o = orders.createProductOrder(req.user, { productId: int(req.body.product_id), optionId: int(req.body.option_id), agreed: req.body.agreed === '1', extraVerification: req.body.extra_verification === '1', companyId: int(req.body.company_id) || null });
  res.redirect(`/checkout/${o.id}`);
}));

r.get('/checkout/:id', needUser, h(async (req, res) => {
  const o = orders.getOrder(req.params.id);
  must(o && o.buyer_id === req.user.id, '주문을 찾을 수 없습니다.', 404);
  if (!['none', 'failed', 'cancelled'].includes(o.payment_status)) return res.redirect(`/my/orders/${o.id}`);
  const s = orders.snapshotOf(o);
  const sched = orders.scheduleCheck(o.delivery_days, o.inspection_days);
  res.page({ title: '결제 전 확인', body: html`<div class="head"><div><h1>결제 전 확인</h1><p class="sub">${o.title}</p></div></div>
    <div class="split"><div>${V.termsCard(o)}</div>
    <aside class="sticky">${card('결제', html`
      <div class="amount">${won(o.amount)}</div><p class="muted">부가세 포함 여부는 판매자 고지에 따릅니다</p>
      ${notice(s.protection.notice, s.protection.mode === 'test' ? 'warn' : '')}
      ${o.payment_status === 'failed' ? notice('이전 결제가 완료되지 않았습니다. 다시 시도할 수 있습니다', 'bad') : ''}
      ${sched.ok ? html`<form method="post" action="/checkout/${o.id}/pay">${csrf(req)}<button class="btn primary block">${s.protection.mode === 'test' ? '테스트 결제 진행' : '결제하기'}</button></form>`
        : notice(html`지금은 결제할 수 없습니다. ${sched.problems.join(' ')}`, 'bad')}
      <ol class="steps mt"><li>결제</li><li>서버가 결제 상태를 확인하면 납품물 접근 허용</li><li>${o.inspection_days}일 검수 후 구매확정 또는 문제 제기</li><li>검수·분쟁·환불 상태 확인 후 판매자 지급</li></ol>`)}</aside></div>` });
}));

r.post('/checkout/:id/pay', needUser, h(async (req, res) => {
  const o = orders.getOrder(req.params.id);
  must(o && o.buyer_id === req.user.id, '주문을 찾을 수 없습니다.', 404);
  const p = await orders.startPayment(o, req.user);
  res.redirect(p.redirectUrl);
}));

// 결제창에서 돌아오는 주소. 이 화면 도착만으로 결제 완료 처리하지 않고 서버가 사업자에 조회한다.
r.get('/pay/return/:id', needUser, h(async (req, res) => {
  const o = orders.getOrder(req.params.id);
  must(o && o.buyer_id === req.user.id, '주문을 찾을 수 없습니다.', 404);
  const pay = q.get('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC', o.id);
  if (pay && pay.status === 'pending') { try { await orders.syncPayment(pay.id); } catch { /* 주문 화면에 확인 대기로 표시 */ } }
  res.redirect(`/my/orders/${o.id}`);
}));

// 토스페이먼츠 결제창(실계정 검증 전 — docs/05 참고)
r.get('/pay/toss/:orderNo', needUser, h(async (req, res) => {
  const o = q.get('SELECT * FROM orders WHERE order_no = ? AND buyer_id = ?', req.params.orderNo, req.user.id);
  must(o, '주문을 찾을 수 없습니다.', 404);
  const cfg = require('../config');
  res.page({ title: '결제', body: html`<div class="narrow card"><h1>결제</h1><p class="sub">${o.title} · ${won(o.amount)}</p>
    <div id="toss" data-client-key="${cfg.tossClientKey}" data-order-id="${o.order_no}" data-amount="${o.amount}" data-name="${o.title}" data-customer="u${req.user.id}"
      data-success="${cfg.baseUrl}/pay/toss-return/success" data-fail="${cfg.baseUrl}/pay/toss-return/fail"></div>
    <button class="btn primary block" id="tosspay">결제창 열기</button>
    <script src="https://js.tosspayments.com/v2/standard"></script><script src="/static/toss.js"></script></div>` });
}));
r.get('/pay/toss-return/:result', needUser, h(async (req, res) => {
  const o = q.get('SELECT * FROM orders WHERE order_no = ? AND buyer_id = ?', String(req.query.orderId || ''), req.user.id);
  must(o, '주문을 찾을 수 없습니다.', 404);
  if (req.params.result === 'success' && req.query.paymentKey) {
    // 금액은 브라우저가 보낸 값이 아니라 주문에 저장된 값으로 승인한다.
    const toss = providers.byName('toss');
    const pay = q.get("SELECT * FROM payments WHERE order_id = ? AND status = 'pending' AND provider = 'toss'", o.id);
    must(pay, '결제 대기 상태가 아닙니다.', 409);
    q.update('payments', pay.id, { provider_payment_id: String(req.query.paymentKey) });
    try { await toss.confirm({ paymentKey: String(req.query.paymentKey), orderId: o.order_no, amount: o.amount }); } catch (e) { res.flash('결제 승인 실패: ' + e.message, 'error'); }
    await orders.syncPayment(pay.id).catch(() => {});
  } else res.flash('결제가 완료되지 않았습니다', 'error');
  res.redirect(`/my/orders/${o.id}`);
}));

// ── 구매 관리
r.get('/my/orders', needUser, (req, res) => {
  const rows = q.all(`SELECT o.* FROM orders o WHERE o.buyer_id = ? OR o.company_id IN (SELECT company_id FROM company_members WHERE user_id = ? AND role IN ('admin','inspector')) ORDER BY o.id DESC LIMIT 200`, req.user.id, req.user.id);
  res.page({ title: '구매 관리', my: true, body: html`<div class="head"><h1>구매 관리</h1></div>
    ${table(['주문', '금액', '결제', '납품', '검수', '환불'], rows.map((o) => [html`<a href="/my/orders/${o.id}">${o.title}</a><br><span class="muted">${o.order_no} · ${fmtDate(o.created_at, false)}</span>`, won(o.amount), badge('payment', o.payment_status), badge('delivery', o.delivery_status), html`${badge('inspection', o.inspection_status)}${o.inspection_status === 'in_progress' ? html`<br><span class="muted">~${fmtDate(o.inspection_due_at, false)}</span>` : ''}`, badge('refund', o.refund_status)]), '구매 내역이 없습니다')}` });
});

function revisionsCard(req, o, role) {
  const revs = q.all('SELECT * FROM revision_requests WHERE order_id = ? ORDER BY id DESC', o.id);
  if (!revs.length) return '';
  const cls = { undetermined: ['미분류', ''], in_scope: ['계약 범위 내', 'ok'], out_of_scope: ['계약 범위 밖 — 추가 개발 견적 대상', 'warn'] };
  return card('수정 요청', revs.map((v) => html`<div class="card flat"><p>${tag(...cls[v.scope_class])} <span class="muted">${fmtDate(v.created_at)}${v.criteria_ref ? ` · 기준: ${v.criteria_ref}` : ''}</span></p><p>${nl2br(v.content)}</p>
    ${v.seller_response ? html`<p class="sub">판매자 답변: ${nl2br(v.seller_response)}</p>` : ''}
    ${v.scope_class === 'out_of_scope' && o.kind === 'milestone' ? html`<p><a href="/my/contracts/${orders.snapshotOf(o).terms.contract_id}">변경 계약(추가 개발 견적)으로 진행</a></p>` : ''}
    ${v.scope_class === 'out_of_scope' && o.kind === 'product' ? html`<p><a href="/requests/new?product=${o.product_id}">추가 개발 요청으로 진행</a></p>` : ''}
    ${role === 'seller' && v.status === 'open' ? html`<form method="post" action="/my/sales/${o.id}/revisions/${v.id}">${csrf(req)}
      ${field('계약 범위 분류', 'scope_class', '', { options: [['in_scope', '계약 범위 내 — 수정하겠습니다'], ['out_of_scope', '계약 범위 밖 — 추가 개발 견적이 필요합니다']] })}
      ${field('답변', 'response', '', { rows: 3, required: true, hint: '범위 밖이라면 계약의 어느 조항에 근거하는지 적어 주세요' })}<button class="btn sm">답변 등록</button></form>` : ''}</div>`));
}
function disputeCard(o) {
  const ds = q.all('SELECT * FROM disputes WHERE order_id = ? ORDER BY id DESC', o.id);
  if (!ds.length) return '';
  return card('분쟁', table(['접수', '유형', '상태', '외부 지급 보류', ''], ds.map((d) => [fmtDate(d.created_at), disputes.REASONS[d.reason_code], d.status === 'resolved' ? `종결 — ${disputes.OUTCOMES[d.resolution]}` : '처리 중', { confirmed: '사업자 확인됨', failed: '요청 실패', unsupported: '미지원(내부 정산만 보류)', not_applicable: '해당 없음(이미 지급)', none: '-', requested: '요청 중' }[d.external_hold], html`<a href="/disputes/${d.id}">열기</a>`])));
}
function threadCard(req, o, me) {
  const other = me === o.buyer_id ? o.seller_id : o.buyer_id;
  const t = messages.open('order', o.id, o.buyer_id, o.seller_id, `주문 ${o.order_no}`);
  const ms = messages.messages(t.id);
  return card('거래 메시지', html`<div class="thread">${ms.length ? ms.map((m) => html`<div class="msg ${m.sender_id === me ? 'me' : ''}"><div class="who">${m.name} · ${fmtDate(m.created_at)}</div>${nl2br(m.body)}</div>`) : html`<p class="muted">요청과 답변은 이곳에 남겨 두세요. 분쟁 시 기록으로 사용됩니다</p>`}</div>
    ${other === me ? '' : html`<form method="post" action="/my/messages/${t.id}">${csrf(req)}${field('메시지', 'body', '', { rows: 2, required: true })}<button class="btn sm">보내기</button></form>`}`);
}

r.get('/my/orders/:id', needUser, h(async (req, res) => {
  const { order: o, role } = orders.loadFor(req.user, req.params.id);
  if (role === 'seller') return res.redirect(`/my/sales/${o.id}`);
  const s = orders.snapshotOf(o);
  const inInspect = o.inspection_status === 'in_progress' && o.dispute_status !== 'open';
  const paid = ['paid', 'partially_refunded'].includes(o.payment_status);
  const hasReview = q.get('SELECT 1 FROM reviews WHERE order_id = ?', o.id);
  const canReview = !hasReview && ['approved', 'auto_approved', 'closed_by_admin'].includes(o.inspection_status) && o.buyer_id === req.user.id;
  const install = s.terms.option?.includes_install;
  const openDispute = o.dispute_status === 'open';
  res.page({ title: o.title, my: true, body: html`
    <div class="head"><div><h1>${o.title}</h1><p class="sub">주문일 ${fmtDate(o.created_at)}</p></div><a class="btn sm" href="/orders/${o.id}/document">거래 문서 출력</a></div>
    ${V.ledgerPanel(o, 'buyer')}
    ${o.kind === 'ip' ? notice(html`자산 인도와 권리 이전 절차 확인은 <a href="/my/ip/deals/${o.ip_deal_id}">권리 거래 화면</a>에서 진행합니다. 모든 인도 항목과 권리 이전 절차를 확인해야 구매확정할 수 있습니다`) : ''}
    ${['none', 'failed', 'cancelled'].includes(o.payment_status) ? notice(html`아직 결제되지 않았습니다. <a href="/checkout/${o.id}">결제 진행</a>`, 'warn') : ''}
    ${o.payment_status === 'pending' ? notice(html`결제 사업자의 확인을 기다리고 있습니다. 결제를 마쳤다면 잠시 후 새로 고침 하세요. <a href="/pay/return/${o.id}">지금 다시 확인</a>`, 'warn') : ''}
    ${V.filesCard(req, o, 'buyer', `/my/orders/${o.id}`)}
    ${inInspect ? card('검수', html`
      <p class="sub">${fmtDate(o.inspection_due_at)}까지 확인해 주세요. 다운로드만으로는 검수가 끝나지 않으며, 구매확정 또는 문제 제기 중 하나를 선택해야 합니다${q.setting('auto_confirm_enabled') === '1' ? '. 기한이 지나면 운영 정책에 따라 자동확정됩니다' : '. 기한이 지나면 판매자가 운영자에게 검수 종료 심사를 요청할 수 있습니다'}</p>
      <form method="post" action="/my/orders/${o.id}/confirm">${csrf(req)}
        ${inspection.CHECKLIST.map(([k, l]) => check(l, 'c_' + k, false))}
        ${install ? check(`설치 완료 조건을 충족했습니다: ${s.terms.product.install_done_criteria || '판매자와 합의한 조건'}`, 'install_done', false) : ''}
        ${field('메모(선택)', 'note', '', { rows: 2 })}
        <button class="btn primary">구매확정</button></form>
      <h3>수정이 필요한가요</h3>
      <form method="post" action="/my/orders/${o.id}/revision">${csrf(req)}
        ${field('관련 계약 기준', 'criteria_ref', '', { placeholder: '예: 검수 기준 2번, 포함 범위의 PDF 출력' })}${field('요청 내용', 'content', '', { rows: 3, required: true })}
        <button class="btn">수정 요청</button></form>`) : ''}
    ${revisionsCard(req, o, 'buyer')}
    ${disputeCard(o)}
    ${paid && !openDispute ? card('문제가 생겼나요', html`
      <p class="sub">문제 제기를 하면 이 거래는 분쟁 절차로 전환되고 판매자 정산이 가능한 범위에서 보류됩니다. 환불은 요청만으로 완료되지 않으며, 합의 또는 운영자 결정 뒤 실제 결제 취소가 확인되어야 완료됩니다</p>
      <form method="post" action="/my/orders/${o.id}/dispute">${csrf(req)}
        <div class="row">${field('문제 유형', 'reason_code', '', { options: Object.entries(disputes.REASONS).filter(([k]) => !['inspection_delay', 'out_of_scope_demand', 'unjust_refund'].includes(k)) })}
        ${field('원하는 처리', 'requested_outcome', '', { options: [['resume', '수정 후 거래 계속'], ['refund_full', '전액 환불'], ['refund_partial', '부분 환불']] })}</div>
        ${field('내용', 'description', '', { rows: 4, required: true, hint: '어떤 계약 기준과 다른지, 어떤 환경에서 확인했는지 적어 주세요' })}
        <button class="btn danger">문제 제기</button></form>`) : ''}
    ${o.payment_status === 'refunded' ? card('환불 후 이용 종료', html`${notice(refunds.LIMIT_NOTICE, 'warn')}
      ${o.use_termination_ack_at ? html`<p>${fmtDate(o.use_termination_ack_at)}에 삭제·이용중단을 확인했습니다</p>` : html`<form method="post" action="/my/orders/${o.id}/ack-termination">${csrf(req)}${check('받은 파일의 사용을 중단하고 보유한 사본을 삭제했습니다', 'ack', false, { required: true })}<button class="btn">확인 제출</button></form>`}`) : ''}
    ${canReview ? card('후기 작성', html`<p class="sub">검수를 마친 실제 구매자만 후기를 남길 수 있습니다</p><form method="post" action="/my/orders/${o.id}/review">${csrf(req)}
      ${field('평점', 'rating', '5', { options: [[5, '5'], [4, '4'], [3, '3'], [2, '2'], [1, '1']] })}${field('후기', 'body', '', { rows: 3, required: true })}<button class="btn">후기 등록</button></form>`) : ''}
    ${V.termsCard(o)}
    ${threadCard(req, o, req.user.id)}
    ${V.timeline(o)}` });
}));

r.post('/my/orders/:id/files/:fid/link', needUser, h(async (req, res) => res.redirect(303, '/dl/' + access.issueForOrder(req.user, int(req.params.id), int(req.params.fid), req))));
r.get('/dl/:token', needUser, h(async (req, res) => {
  const f = access.consume(req.user, req.params.token, req);
  if (!storage.isReadable(f)) throw new AppError('파일을 읽을 수 없습니다. 고객지원에 알려 주세요.', 500);
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': f.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.original_name)}`, 'Cache-Control': 'no-store', 'X-Checksum-Sha256': f.sha256 });
  storage.openStream(f).on('error', () => res.destroy()).pipe(res);
}));

r.post('/my/orders/:id/confirm', needUser, h(async (req, res) => {
  const checklist = Object.fromEntries(inspection.CHECKLIST.map(([k]) => [k, req.body['c_' + k] === '1']));
  inspection.confirm(req.user, int(req.params.id), { checklist, installDone: req.body.install_done === '1', note: req.body.note });
  res.flash('구매를 확정했습니다. 정산 조건 확인 후 판매자에게 지급됩니다'); res.back();
}));
r.post('/my/orders/:id/revision', needUser, h(async (req, res) => { inspection.requestRevision(req.user, int(req.params.id), { criteriaRef: req.body.criteria_ref, content: req.body.content }); res.flash('수정 요청을 보냈습니다'); res.back(); }));
r.post('/my/orders/:id/dispute', needUser, h(async (req, res) => {
  const d = await disputes.open(req.user, int(req.params.id), { reasonCode: req.body.reason_code, description: req.body.description, requestedOutcome: req.body.requested_outcome });
  res.redirect(`/disputes/${d.id}`);
}));
r.post('/my/orders/:id/ack-termination', needUser, h(async (req, res) => { must(req.body.ack === '1', '확인란에 체크하세요.'); refunds.ackTermination(req.user, int(req.params.id)); res.flash('확인이 기록되었습니다'); res.back(); }));
r.post('/my/orders/:id/review', needUser, h(async (req, res) => {
  const o = orders.getOrder(req.params.id);
  // 실제 구매자만, 검수를 마친 주문에 한 번
  must(o && o.buyer_id === req.user.id && ['approved', 'auto_approved', 'closed_by_admin'].includes(o.inspection_status), '검수를 마친 구매자만 후기를 쓸 수 있습니다.', 403);
  must(str(req.body.body).length >= 10, '후기를 10자 이상 적어 주세요.');
  must(!q.get('SELECT 1 FROM reviews WHERE order_id = ?', o.id), '이미 후기를 작성했습니다.', 409);
  q.insert('reviews', { order_id: o.id, product_id: o.product_id, seller_id: o.seller_id, buyer_id: o.buyer_id, rating: Math.min(Math.max(int(req.body.rating, 5), 1), 5), body: str(req.body.body, 2000), created_at: new Date().toISOString() });
  res.flash('후기가 등록되었습니다'); res.back();
}));

// ── 판매 관리
r.get('/my/sales', needUser, (req, res) => {
  const rows = q.all("SELECT * FROM orders WHERE seller_id = ? AND payment_status <> 'none' ORDER BY id DESC LIMIT 200", req.user.id);
  res.page({ title: '판매 관리', my: true, body: html`<div class="head"><h1>판매 관리</h1></div>
    ${table(['주문', '금액', '결제', '납품', '검수', '분쟁', '지급'], rows.map((o) => [html`<a href="/my/sales/${o.id}">${o.title}</a><br><span class="muted">${o.order_no}</span>`, won(o.amount), badge('payment', o.payment_status), html`${badge('delivery', o.delivery_status)}${o.delivery_due_at && o.delivery_status !== 'delivered' ? html`<br><span class="muted">~${fmtDate(o.delivery_due_at, false)}</span>` : ''}`, badge('inspection', o.inspection_status), badge('dispute', o.dispute_status), badge('payout', o.payout_status)]), '판매 내역이 없습니다')}` });
});

r.get('/my/sales/:id', needUser, h(async (req, res) => {
  const { order: o, role } = orders.loadFor(req.user, req.params.id);
  if (role !== 'seller') return res.redirect(`/my/orders/${o.id}`);
  const canDeliver = o.kind !== 'ip' && ['awaiting_seller', 'redelivery_requested'].includes(o.delivery_status) && ['paid', 'partially_refunded'].includes(o.payment_status);
  const draft = q.get("SELECT * FROM deliveries WHERE order_id = ? AND status = 'draft'", o.id);
  const dfiles = draft ? deliveries.filesOf(draft.id) : [];
  const reqs = deliveries.requirements(o);
  const overdue = o.inspection_status === 'in_progress' && o.inspection_due_at < new Date().toISOString() && o.dispute_status !== 'open';
  const paid = ['paid', 'partially_refunded'].includes(o.payment_status);
  res.page({ title: o.title, my: true, body: html`
    <div class="head"><div><h1>${o.title}</h1><p class="sub">판매 주문 · ${fmtDate(o.created_at)}</p></div><a class="btn sm" href="/orders/${o.id}/document">거래 문서 출력</a></div>
    ${V.ledgerPanel(o, 'seller')}
    ${o.kind === 'ip' ? notice(html`자산 인도는 <a href="/my/ip/deals/${o.ip_deal_id}">권리 거래 화면</a>의 인도 목록에서 항목별로 진행합니다`) : ''}
    ${o.payment_status === 'pending' || o.payment_status === 'none' ? notice('결제가 확인되지 않았습니다. 결제 확인 전에는 작업을 시작하지 마세요', 'warn') : ''}
    ${canDeliver ? card('납품 등록', html`
      <p class="sub">납품 기한 ${fmtDate(o.delivery_due_at)}. 제출하면 파일 목록이 고정되고 구매자의 검수 기간이 시작됩니다${reqs.requiresSource ? '. 이 거래는 소스코드와 실행 방법이 포함되어야 제출할 수 있습니다. 화면 캡처나 시연 영상만으로는 완료 처리되지 않습니다' : ''}</p>
      ${notice('운영 비밀번호, 실사용 API 키, 개인정보가 담긴 DB는 넣지 마세요. 업로드 시 자동 검사하며 문제가 발견되면 제출할 수 없습니다')}
      ${table(['파일', '종류', '검사', ''], dfiles.map((f) => [html`${f.original_name} <span class="muted">${ui.size(f.size)}</span>`, deliveries.ROLES[f.role], V.scanCells(f), postBtn(req, `/my/sales/${o.id}/delivery/remove`, '빼기', { cls: 'sm', fields: { file_id: f.id } })]), '아직 올린 파일이 없습니다')}
      <form method="post" action="/my/sales/${o.id}/delivery/file?_csrf=${req.csrfToken}" enctype="multipart/form-data" class="row my">
        ${field('파일', 'file', '', { type: 'file', required: true })}${field('종류', 'role', '', { options: Object.entries(deliveries.ROLES) })}<div class="field"><label>&nbsp;</label><button class="btn">파일 올리기</button></div></form>
      <form method="post" action="/my/sales/${o.id}/delivery/submit">${csrf(req)}
        ${field('실행 방법', 'run_instructions', draft?.run_instructions || '', { rows: 3, hint: '설치 설명서 파일을 올렸다면 요약만 적어도 됩니다' })}${field('납품 메모', 'note', draft?.note || '', { rows: 2 })}
        <button class="btn primary">납품 제출</button></form>`) : ''}
    ${V.filesCard(req, o, 'seller', `/my/orders/${o.id}`)}
    ${revisionsCard(req, o, 'seller')}
    ${overdue ? card('검수 기한 경과', html`<p class="sub">구매자가 기한 내 확정이나 문제 제기를 하지 않았습니다. 운영자에게 검수 종료 심사를 요청할 수 있습니다${o.close_review_requested_at ? ` (요청일 ${fmtDate(o.close_review_requested_at)})` : ''}</p>
      ${o.close_review_requested_at ? '' : postBtn(req, `/my/sales/${o.id}/close-review`, '검수 종료 심사 요청')}`) : ''}
    ${disputeCard(o)}
    ${paid && o.dispute_status !== 'open' ? card('구매자와 문제가 있나요', html`<p class="sub">검수 지연, 계약 밖 요구, 근거 없는 환불 요구가 있다면 증빙과 함께 운영자 검토를 요청할 수 있습니다</p>
      <form method="post" action="/my/orders/${o.id}/dispute">${csrf(req)}${field('유형', 'reason_code', '', { options: [['inspection_delay', disputes.REASONS.inspection_delay], ['out_of_scope_demand', disputes.REASONS.out_of_scope_demand], ['unjust_refund', disputes.REASONS.unjust_refund], ['other', '기타']] })}
      ${field('내용', 'description', '', { rows: 3, required: true })}<button class="btn">운영자 검토 요청</button></form>`) : ''}
    ${V.moneyCard(o, 'seller')}${V.blockersCard(o)}
    ${V.termsCard(o)}
    ${threadCard(req, o, req.user.id)}
    ${V.timeline(o)}` });
}));
r.post('/my/sales/:id/delivery/file', needUser, receiveFile('delivery'), h(async (req, res) => { deliveries.addFile(req.user, int(req.params.id), req.savedFile, req.body.role); res.flash('파일을 올렸습니다. 검사 결과를 확인하세요'); res.back(); }));
r.post('/my/sales/:id/delivery/remove', needUser, h(async (req, res) => { deliveries.removeFile(req.user, int(req.params.id), int(req.body.file_id)); res.back(); }));
r.post('/my/sales/:id/delivery/submit', needUser, h(async (req, res) => { deliveries.submit(req.user, int(req.params.id), { note: req.body.note, runInstructions: req.body.run_instructions }); res.flash('납품을 제출했습니다. 구매자의 검수 기간이 시작되었습니다'); res.back(); }));
r.post('/my/sales/:id/revisions/:rid', needUser, h(async (req, res) => { inspection.respondRevision(req.user, int(req.params.rid), { scopeClass: req.body.scope_class, response: req.body.response }); res.flash('답변을 등록했습니다'); res.back(); }));
r.post('/my/sales/:id/close-review', needUser, h(async (req, res) => { inspection.requestCloseReview(req.user, int(req.params.id)); res.flash('검수 종료 심사를 요청했습니다'); res.back(); }));

// ── 거래 문서 출력
r.get('/orders/:id/document', needUser, h(async (req, res) => {
  const o = orders.getOrder(req.params.id);
  const role = o && (orders.roleIn(o, req.user) || (req.user.staff.length ? 'staff' : null));
  must(role, '주문을 찾을 수 없습니다.', 404);
  const names = (id) => q.get('SELECT name FROM users WHERE id = ?', id)?.name;
  res.page({ title: `거래 문서 ${o.order_no}`, body: html`<div class="head"><div><h1>거래 확인서</h1><p class="sub">${o.order_no} · 발행 ${fmtDate(new Date().toISOString())}</p></div><span class="noprint muted">브라우저의 인쇄 기능으로 출력하세요</span></div>
    ${card('당사자', ui.dl([['구매자', names(o.buyer_id)], ['판매자', q.get('SELECT display_name FROM seller_profiles WHERE user_id = ?', o.seller_id)?.display_name || names(o.seller_id)], ['중개', '이음마켓(통신판매중개자, 거래 당사자 아님)'], ['조건 지문(SHA-256)', html`<code class="hash">${o.terms_hash}</code>`]]))}
    ${V.ledgerPanel(o, role)}${V.termsCard(o)}${V.moneyCard(o, role)}${V.timeline(o)}
    <p class="muted">이 문서는 플랫폼에 기록된 거래 상태를 보여 주는 확인서이며 세금계산서나 법률 검토를 거친 계약서가 아닙니다</p>` });
}));

module.exports = r;
