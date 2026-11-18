'use strict';
// 분쟁 · 메시지 · 알림 · 신고 · 계정 · AI 초안
const r = require('express').Router();
const { q } = require('../db');
const { h, needUser, receiveFile } = require('../web');
const ui = require('../ui');
const { html, csrf, field, check, card, notice, tag, won, fmtDate, table, nl2br, postBtn } = ui;
const { must, int, str, toWon, clock } = require('../util');
const disputes = require('../services/disputes');
const orders = require('../services/orders');
const messages = require('../services/messages');
const access = require('../services/access');
const accounts = require('../services/accounts');
const ai = require('../services/ai');
const V = require('../views/order');

const HOLD = { confirmed: ['결제 사업자가 보류를 확인함', 'ok'], failed: ['결제 사업자 보류 요청 실패', 'bad'], unsupported: ['미지원 — 플랫폼 정산 요청만 보류', 'warn'], not_applicable: ['해당 없음 — 이미 지급된 거래', 'warn'], requested: ['요청 중', 'warn'], none: ['확인 중', ''] };
const D_STATUS = { open: '당사자 협의 중', admin_review: '운영자 검토 중', resolved: '종결', appealed: '이의제기 검토 중', external: '외부 절차 안내' };

r.get('/my/disputes', needUser, (req, res) => {
  const ds = q.all(`SELECT d.*, o.title, o.order_no FROM disputes d JOIN orders o ON o.id = d.order_id WHERE o.buyer_id = ? OR o.seller_id = ? ORDER BY d.id DESC`, req.user.id, req.user.id);
  const reports = q.all('SELECT * FROM reports WHERE reporter_id = ? ORDER BY id DESC LIMIT 50', req.user.id);
  res.page({ title: '신고·분쟁', my: true, body: html`<div class="head"><h1>신고·분쟁</h1></div>
    ${card('분쟁', table(['주문', '유형', '상태', '접수'], ds.map((d) => [html`<a href="/disputes/${d.id}">${d.title}</a><br><span class="muted">${d.order_no}</span>`, disputes.REASONS[d.reason_code], D_STATUS[d.status], fmtDate(d.created_at)]), '분쟁 내역이 없습니다'))}
    ${card('내가 접수한 신고', table(['대상', '유형', '상태', '조치', '접수'], reports.map((x) => [`${x.target_type} #${x.target_id}`, x.kind, { open: '접수', reviewing: '검토 중', actioned: '조치 완료', dismissed: '종결' }[x.status], x.action_note, fmtDate(x.created_at)]), '신고 내역이 없습니다'))}` });
});

r.get('/disputes/:id', needUser, h(async (req, res) => {
  const { dispute: d, order: o, role } = disputes.loadFor(req.user, int(req.params.id));
  const entries = q.all('SELECT e.*, u.name FROM dispute_entries e JOIN users u ON u.id = e.user_id WHERE e.dispute_id = ? ORDER BY e.id', d.id);
  const answered = new Set(entries.filter((e) => e.kind.startsWith('proposal_')).map((e) => e.body));
  const sideOf = (uid) => (uid === o.seller_id ? '판매자' : orders.roleIn(o, { id: uid }) === 'buyer' ? '구매자' : '운영자');
  const active = ['open', 'admin_review', 'appealed'].includes(d.status);
  const canAppeal = d.status === 'resolved' && d.appeal_deadline && d.appeal_deadline > clock.iso() && !d.appeal_at;
  res.page({ title: '분쟁', my: true, body: html`
    <div class="head"><div><h1>분쟁 — ${disputes.REASONS[d.reason_code]}</h1><p class="sub"><a href="/my/${role === 'seller' ? 'sales' : 'orders'}/${o.id}">${o.title}</a> · ${D_STATUS[d.status]} · 접수 ${fmtDate(d.created_at)}</p></div></div>
    ${card('정산 보류 상태', html`${ui.dl([
      ['플랫폼 내부', html`${ui.badge('payout', o.payout_status)} <span class="muted">플랫폼이 판매자 지급 요청을 하지 않는 상태입니다. 이것만으로 결제 사업자의 지급이 멈추는 것은 아닙니다</span>`],
      ['결제 사업자(외부)', html`${tag(...HOLD[d.external_hold])} <span class="muted">${d.external_hold_detail}</span>`],
    ])}${d.post_payout ? notice('이미 판매자에게 지급된 거래입니다. 일반 보류로 되돌릴 수 없어 사후 환불·회수 검토 절차로 진행합니다', 'warn') : ''}`)}
    ${V.ledgerPanel(o, role)}
    ${card('접수 내용', html`<p>${nl2br(d.description)}</p>${d.requested_outcome ? html`<p class="sub">요청: ${disputes.OUTCOMES[d.requested_outcome]}</p>` : ''}`)}
    ${card('양측 자료와 제안', html`<div class="thread">${entries.map((e) => html`<div class="msg ${e.user_id === req.user.id ? 'me' : ''}"><div class="who">${sideOf(e.user_id)} · ${fmtDate(e.created_at)} · ${{ statement: '진술', evidence: '증빙', proposal: '합의 제안', proposal_accept: '제안 수락', proposal_decline: '제안 거절', admin_note: '운영자' }[e.kind]}</div>
        ${e.kind === 'proposal' ? html`<p><b>${disputes.OUTCOMES[e.proposal_type]}${e.proposal_amount ? ` ${won(e.proposal_amount)}` : ''}</b></p>` : ''}
        ${e.kind.startsWith('proposal_') ? `제안 #${e.body}` : nl2br(e.body)}
        ${e.file_id ? html`<p>${postBtn(req, `/disputes/${d.id}/files/${e.file_id}`, '첨부 파일 받기', { cls: 'sm' })}</p>` : ''}
        ${e.kind === 'proposal' && d.status === 'open' && !answered.has(String(e.id)) && orders.roleIn(o, { id: e.user_id }) !== role ? html`<div class="actions">${postBtn(req, `/disputes/${d.id}/proposals/${e.id}`, '이 제안 수락', { cls: 'sm primary', fields: { accept: 1 } })}${postBtn(req, `/disputes/${d.id}/proposals/${e.id}`, '거절', { cls: 'sm', fields: { accept: 0 } })}</div>` : ''}
      </div>`)}</div>
      ${active ? html`<form method="post" action="/disputes/${d.id}/entries?_csrf=${req.csrfToken}" enctype="multipart/form-data">
        ${field('진술 또는 증빙 설명', 'body', '', { rows: 3 })}${field('증빙 파일(선택)', 'file', '', { type: 'file' })}<button class="btn sm">자료 제출</button></form>` : ''}`)}
    ${d.status === 'open' ? card('합의 제안', html`<p class="sub">상대방이 수락하면 그대로 처리됩니다. 환불은 실제 결제 취소가 확인되어야 완료됩니다</p>
      <form method="post" action="/disputes/${d.id}/proposals">${csrf(req)}<div class="row">${field('제안', 'type', '', { options: Object.entries(disputes.OUTCOMES).filter(([k]) => k !== 'external') })}${field('부분 환불 금액', 'amount', '', { placeholder: '부분 환불일 때만' })}</div>
        ${field('설명', 'body', '', { rows: 2 })}<button class="btn">제안 보내기</button></form>
      <h3>합의가 어렵다면</h3>${postBtn(req, `/disputes/${d.id}/escalate`, '운영자 판단 요청')}`) : ''}
    ${d.resolved_at ? card('처리 결과', html`${ui.dl([['결과', html`${disputes.OUTCOMES[d.resolution]}${d.resolution_amount ? ` ${won(d.resolution_amount)}` : ''}`], ['근거', nl2br(d.resolution_reason)], ['처리', `${d.resolved_by ? '운영자' : '양측 합의'} · ${fmtDate(d.resolved_at)}`],
        ['환불 진행', ui.badge('refund', o.refund_status)], d.appeal_deadline ? ['이의제기 기한', fmtDate(d.appeal_deadline)] : null])}
      <p class="hint">${disputes.EXTERNAL_GUIDE}</p>
      ${canAppeal ? html`<form method="post" action="/disputes/${d.id}/appeal">${csrf(req)}${field('이의제기 사유', 'text', '', { rows: 3, required: true })}<button class="btn">이의제기</button></form>` : ''}
      ${d.appeal_at ? html`<p class="sub">이의제기 접수: ${fmtDate(d.appeal_at)}</p>` : ''}`) : ''}` });
}));
r.post('/disputes/:id/entries', needUser, receiveFile('evidence', { required: false }), h(async (req, res) => {
  disputes.addEntry(req.user, int(req.params.id), { kind: req.savedFile ? 'evidence' : 'statement', body: req.body.body, fileId: req.savedFile?.id ?? null });
  res.flash('제출했습니다'); res.back();
}));
r.post('/disputes/:id/files/:fid', needUser, h(async (req, res) => {
  const { dispute: d } = disputes.loadFor(req.user, int(req.params.id));
  must(q.get('SELECT 1 FROM dispute_entries WHERE dispute_id = ? AND file_id = ?', d.id, int(req.params.fid)), '찾을 수 없습니다.', 404);
  res.redirect(303, '/dl/' + access.issue(req.user, { orderId: d.order_id, fileId: int(req.params.fid), context: 'evidence' }, req));
}));
r.post('/disputes/:id/proposals', needUser, h(async (req, res) => { disputes.propose(req.user, int(req.params.id), { type: req.body.type, amount: req.body.amount ? toWon(req.body.amount) : null, body: req.body.body }); res.flash('제안을 보냈습니다'); res.back(); }));
r.post('/disputes/:id/proposals/:eid', needUser, h(async (req, res) => { await disputes.answerProposal(req.user, int(req.params.id), int(req.params.eid), req.body.accept === '1'); res.flash(req.body.accept === '1' ? '제안을 수락했습니다. 처리 상태를 확인하세요' : '제안을 거절했습니다'); res.back(); }));
r.post('/disputes/:id/escalate', needUser, h(async (req, res) => { disputes.escalate(req.user, int(req.params.id)); res.flash('운영자 판단을 요청했습니다'); res.back(); }));
r.post('/disputes/:id/appeal', needUser, h(async (req, res) => { disputes.appeal(req.user, int(req.params.id), req.body.text); res.flash('이의제기를 접수했습니다'); res.back(); }));

// ── 메시지
r.get('/my/messages', needUser, (req, res) => res.page({ title: '메시지', my: true, body: html`<div class="head"><h1>메시지</h1></div>
  ${table(['대화', '상대', '최근 내용', '일시'], messages.list(req.user).map((t) => [html`<a href="/my/messages/${t.id}">${t.subject}</a>`, t.other_name, str(t.last_body, 60), fmtDate(t.last_at)]), '메시지가 없습니다')}` }));
r.get('/my/messages/:id', needUser, h(async (req, res) => {
  const t = messages.load(req.user, int(req.params.id));
  res.page({ title: t.subject, my: true, body: html`<div class="head"><div><h1>${t.subject}</h1>${t.kind === 'order' ? html`<p><a href="/my/orders/${t.ref_id}">주문 화면으로</a></p>` : t.kind === 'inquiry' ? html`<p><a href="/products/${t.ref_id}">상품 보기</a></p>` : ''}</div></div>
    <div class="thread">${messages.messages(t.id).map((m) => html`<div class="msg ${m.sender_id === req.user.id ? 'me' : ''}"><div class="who">${m.name} · ${fmtDate(m.created_at)}</div>${nl2br(m.body)}</div>`)}</div>
    <form method="post" action="/my/messages/${t.id}">${csrf(req)}${field('메시지', 'body', '', { rows: 3, required: true })}<button class="btn primary">보내기</button></form>` });
}));
r.post('/my/messages/:id', needUser, h(async (req, res) => { messages.post(req.user, int(req.params.id), req.body.body); res.back(); }));
r.post('/inquiry', needUser, h(async (req, res) => {
  const p = q.get("SELECT * FROM products WHERE id = ? AND status = 'approved'", int(req.body.product_id));
  must(p, '상품을 찾을 수 없습니다.', 404);
  const t = messages.open('inquiry', p.id, req.user.id, p.seller_id, `구매 전 문의: ${p.title}`);
  messages.post(req.user, t.id, req.body.body);
  res.redirect(`/my/messages/${t.id}`);
}));

// ── 알림
r.get('/my/notifications', needUser, (req, res) => {
  const ns = q.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100', req.user.id);
  q.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', clock.iso(), req.user.id);
  res.page({ title: '알림', my: true, body: html`<div class="head"><h1>알림</h1></div>
    ${table(['일시', '내용'], ns.map((n) => [fmtDate(n.created_at), html`${n.read_at ? '' : tag('새 알림', 'warn')} ${n.link ? html`<a href="${n.link}">${n.title}</a>` : n.title}<br><span class="muted">${n.body}</span>`]), '알림이 없습니다')}
    <p class="hint">알림은 사이트 안에서만 제공됩니다. 이메일·문자 발송은 연동되어 있지 않습니다</p>` });
});

// ── 신고
r.post('/report', needUser, h(async (req, res) => {
  must(['product', 'ip_listing', 'review', 'user', 'order'].includes(req.body.target_type) && int(req.body.target_id), '잘못된 신고 대상입니다.');
  must(['rights_infringement', 'malware', 'fraud', 'redistribution', 'fake_review', 'other'].includes(req.body.kind), '신고 유형을 선택하세요.');
  must(str(req.body.body).length >= 10, '신고 내용을 10자 이상 적어 주세요.');
  const id = q.insert('reports', { reporter_id: req.user.id, target_type: req.body.target_type, target_id: int(req.body.target_id), kind: req.body.kind, body: str(req.body.body, 3000), created_at: clock.iso() });
  require('../log').notifyStaff('support', '신고 접수', `${req.body.kind} — ${req.body.target_type} #${int(req.body.target_id)}`, `/admin/reports#r${id}`);
  res.flash('신고가 접수되었습니다. 처리 상태는 신고·분쟁 메뉴에서 볼 수 있습니다'); res.back();
}));

// ── 계정
r.get('/my/account', needUser, (req, res) => res.page({ title: '계정', my: true, body: html`<div class="head"><h1>계정</h1></div>
  ${card('기본 정보', ui.dl([['이메일', req.user.email], ['이름', req.user.name], ['판매자', req.user.seller ? html`${ui.badge('seller', req.user.seller.status)} <a href="/my/seller">상점 정보</a>` : html`<a href="/my/seller">판매자 등록</a>`], ['찜한 상품', html`<a href="/my/favorites">보기</a>`]]))}
  ${card('회원 탈퇴', html`<p class="sub">진행 중인 거래가 없어야 탈퇴할 수 있습니다. 판매자가 탈퇴해도 기존 구매자의 납품물 접근은 보관 정책(${q.settingInt('retention_days')}일)에 따라 유지되며, 거래·정산 기록은 법령상 보존 기간 동안 보관됩니다</p>
    <form method="post" action="/my/account/withdraw">${csrf(req)}${field('비밀번호 확인', 'password', '', { type: 'password', required: true })}${check('위 내용을 확인했습니다', 'ack', false, { required: true })}<button class="btn danger">탈퇴</button></form>`)}` }));
r.post('/my/account/withdraw', needUser, h(async (req, res) => {
  must(req.body.ack === '1', '확인란에 체크하세요.');
  accounts.reauth(req.user, req.body.password);
  accounts.withdraw(req.user);
  res.clearCookie('eum_sid', { path: '/' }); res.redirect('/');
}));

// ── AI 초안(선택 기능)
r.get('/ai/draft', needUser, (req, res) => {
  const kind = ai.KINDS[req.query.kind] ? req.query.kind : 'request_draft';
  res.page({ title: 'AI 초안', body: html`<div class="head"><div><h1>AI 초안 도우미</h1><p class="sub">초안 작성만 돕습니다. 환불이나 권리 분쟁의 판단에는 쓰이지 않으며 결과는 직접 검토해야 합니다</p></div></div>
    ${ai.enabled() ? '' : notice('이 서버에는 AI 연동이 설정되어 있지 않습니다. 모든 거래 기능은 AI 없이 그대로 사용할 수 있습니다', 'warn')}
    ${req.aiResult ? card('초안', html`<p>${nl2br(req.aiResult)}</p><p class="hint">필요한 부분을 복사해 의뢰서·상품 설명에 붙여 넣고 사실과 다른 부분을 고치세요</p>`) : ''}
    <form method="post" action="/ai/draft" class="card">${csrf(req)}
      ${field('작업', 'kind', kind, { options: Object.entries(ai.KINDS).map(([k, v]) => [k, v[0]]) })}
      ${field('내용', 'input', req.aiInput || '', { rows: 10, required: true, hint: '비공개 소스코드, 계약서 원문, 개인정보, 비밀키는 넣지 마세요' })}
      ${check('입력한 내용이 외부 AI 서비스(Anthropic)로 전송되는 것에 동의합니다', 'consent', false, { required: true })}
      <button class="btn primary">초안 만들기</button></form>` });
});
r.post('/ai/draft', needUser, h(async (req, res, next) => {
  req.aiInput = str(req.body.input, 12000);
  req.aiResult = await ai.draft(req.user, req.body.kind, req.body.input, req.body.consent === '1');
  req.query.kind = req.body.kind; req.method = 'GET'; req.url = '/ai/draft';
  r.handle(req, res, next);
}));

module.exports = r;
