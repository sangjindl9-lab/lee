'use strict';
const { won, fmtDate, bpsPct } = require('./util');

// ── 자동 이스케이프 템플릿
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const render = (v) => (v instanceof Safe ? v.s : Array.isArray(v) ? v.map(render).join('') : v === null || v === undefined || v === false || v === true ? '' : esc(v));
const html = (strings, ...vals) => new Safe(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? render(vals[i]) : ''), ''));
const raw = (s) => new Safe(String(s ?? ''));
const nl2br = (s) => raw(esc(s).replace(/\n/g, '<br>'));
const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
const bullets = (s) => (lines(s).length ? html`<ul class="list">${lines(s).map((l) => html`<li>${l.replace(/^[-•·]\s*/, '')}</li>`)}</ul>` : html`<p class="muted">기재 없음</p>`);

// ── 상태 표시 문구. 화면은 저장된 상태 값만으로 문구를 고른다.
const LABELS = {
  payment: { none: ['결제 전', ''], pending: ['결제 확인 대기', 'warn'], paid: ['결제 확인됨', 'ok'], partially_refunded: ['부분 환불됨', 'warn'], refunded: ['전액 환불됨', 'bad'], failed: ['결제 실패', 'bad'], cancelled: ['결제 취소', 'bad'] },
  protection: { none: ['해당 없음', ''], simulated: ['테스트 결제 — 실제 대금 보호 없음', 'warn'], held: ['결제 사업자 보류 중', 'ok'], released: ['보류 해제됨', ''], unsupported: ['사업자 대금 보호 미적용', 'warn'], unknown: ['사업자 상태 확인 중', 'warn'] },
  delivery: { not_ready: ['결제 후 제공', ''], awaiting_seller: ['판매자 납품 대기', 'warn'], delivered: ['납품물 접근 가능', 'ok'], access_failed: ['파일 접근 문제 — 복구 중', 'bad'], redelivery_requested: ['재납품 대기', 'warn'] },
  inspection: { not_started: ['검수 시작 전', ''], in_progress: ['검수 중', 'warn'], approved: ['구매확정', 'ok'], auto_approved: ['기한 경과 자동확정', 'ok'], closed_by_admin: ['운영자 검수 종료', 'ok'], rejected: ['검수 거절', 'bad'] },
  dispute: { none: ['없음', ''], open: ['분쟁 처리 중', 'bad'], resolved: ['분쟁 종결', ''] },
  refund: { none: ['없음', ''], requested: ['환불 요청됨(미완료)', 'warn'], processing: ['환불 처리 중(미완료)', 'warn'], completed: ['환불 완료', 'bad'], failed: ['환불 실패 — 재처리 필요', 'bad'], rejected: ['환불 요청 기각', ''], manual_required: ['수동 처리 필요', 'warn'] },
  payout: { not_eligible: ['정산 조건 미충족', ''], eligible: ['지급 요청 가능', 'ok'], requested: ['지급 요청 접수(미완료)', 'warn'], unknown: ['지급 결과 확인 중', 'warn'], paid: ['지급 완료', 'ok'], failed: ['지급 실패', 'bad'], held: ['정산 보류', 'warn'], clawback_review: ['사후 환불·회수 검토', 'bad'] },
  scan: { pending: ['대기', ''], scanning: ['검사 중', 'warn'], passed: ['통과', 'ok'], flagged: ['문제 발견', 'bad'], unscannable: ['검사 불가', 'warn'] },
  product: { draft: ['작성 중', ''], pending_review: ['심사 대기', 'warn'], approved: ['판매 중', 'ok'], rejected: ['반려', 'bad'], suspended: ['판매 정지', 'bad'], deleted: ['삭제됨', ''] },
  seller: { pending: ['심사 대기', 'warn'], approved: ['승인', 'ok'], rejected: ['반려', 'bad'], suspended: ['정지', 'bad'] },
  generic: {},
};
const label = (kind, v) => (LABELS[kind]?.[v] || [v, ''])[0];
const badge = (kind, v, text) => { const [l, tone] = LABELS[kind]?.[v] || [v, '']; return html`<span class="badge ${tone}">${text || l}</span>`; };
const tag = (text, tone = '') => html`<span class="badge ${tone}">${text}</span>`;
const hashChip = (h, n = 12) => (h ? html`<code class="hash" title="${h}">${String(h).slice(0, n)}</code>` : '');
const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');

// ── 폼
const csrf = (req) => html`<input type="hidden" name="_csrf" value="${req.csrfToken}">`;
function field(labelText, name, value = '', o = {}) {
  const id = 'f_' + name;
  let input;
  if (o.options) input = html`<select id="${id}" name="${name}">${o.options.map(([v, l]) => html`<option value="${v}" ${String(v) === String(value ?? '') ? raw('selected') : ''}>${l}</option>`)}</select>`;
  else if (o.rows) input = html`<textarea id="${id}" name="${name}" rows="${o.rows}" ${o.required ? raw('required') : ''} placeholder="${o.placeholder || ''}">${value}</textarea>`;
  else input = html`<input id="${id}" name="${name}" type="${o.type || 'text'}" value="${value ?? ''}" ${o.required ? raw('required') : ''} placeholder="${o.placeholder || ''}" ${o.attrs ? raw(o.attrs) : ''}>`;
  return html`<div class="field"><label for="${id}">${labelText}</label>${input}${o.hint ? html`<p class="hint">${o.hint}</p>` : ''}</div>`;
}
const check = (labelText, name, checked, o = {}) => html`<label class="check"><input type="checkbox" name="${name}" value="1" ${checked ? raw('checked') : ''} ${o.required ? raw('required') : ''}><span>${labelText}</span></label>`;
// 한 줄짜리 POST 버튼
const postBtn = (req, action, text, o = {}) => html`<form method="post" action="${action}" class="inline">${csrf(req)}${Object.entries(o.fields || {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button class="btn ${o.cls || ''}">${text}</button></form>`;

const table = (heads, rows, emptyText = '내역이 없습니다') => (rows.length
  ? html`<div class="table-wrap"><table><thead><tr>${heads.map((h) => html`<th>${h}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div>`
  : html`<p class="empty">${emptyText}</p>`);
const dl = (pairs) => html`<dl class="dl">${pairs.filter(Boolean).map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
const card = (title, body, o = {}) => html`<section class="card ${o.cls || ''}">${title ? html`<h2>${title}</h2>` : ''}${body}</section>`;
const notice = (body, tone = '') => html`<div class="notice ${tone}">${body}</div>`;

// ── 레이아웃
const NAV = [['/market?type=license', '솔루션 마켓'], ['/market?type=source', '소스코드 마켓'], ['/requests', '맞춤 개발 의뢰'], ['/ip', '지식재산권 거래'], ['/experts', '전문가 찾기'], ['/guide', '안전거래 안내'], ['/support', '고객지원']];
const MY_NAV = [['/my/orders', '구매 관리'], ['/my/sales', '판매 관리'], ['/my/products', '내 상품'], ['/my/requests', '견적·의뢰'], ['/my/contracts', '계약·검수'], ['/my/ip', '권리 거래'], ['/my/messages', '메시지'], ['/my/payouts', '정산'], ['/my/disputes', '신고·분쟁'], ['/my/company', '기업 계정'], ['/my/account', '계정']];

function page(req, { title, body, my = false, admin = false, adminNav = null }) {
  const u = req.user;
  const flash = req.flash;
  const side = admin ? adminNav : my ? MY_NAV : null;
  const cur = req.path;
  const out = html`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? title + ' · ' : ''}이음마켓</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<link rel="stylesheet" href="/static/style.css"></head>
<body>
<header class="top"><div class="wrap top-in">
  <a class="logo" href="/">이음마켓<span>EUM MARKET</span></a>
  <input type="checkbox" id="navtoggle" class="navtoggle"><label for="navtoggle" class="navbtn">메뉴</label>
  <nav class="main">${NAV.map(([h, l]) => html`<a href="${h}">${l}</a>`)}</nav>
  <div class="user">${u
    ? html`${u.staff.length ? html`<a href="/admin">운영</a>` : ''}<a href="/my/notifications">알림${req.unread ? html`<b class="count">${req.unread}</b>` : ''}</a><a href="/my/orders">내 거래</a><form method="post" action="/logout" class="inline">${csrf(req)}<button class="link">로그아웃</button></form>`
    : html`<a href="/login">로그인</a><a class="btn primary sm" href="/signup">회원가입</a>`}</div>
</div></header>
${req.testMode ? html`<div class="testbar"><div class="wrap">테스트 결제 환경입니다. 실제 돈이 이동하지 않으며 결제대금 보호도 적용되지 않습니다</div></div>` : ''}
<main class="wrap ${side ? 'with-side' : ''}">
  ${side ? html`<aside class="side"><nav>${side.map(([h, l]) => html`<a href="${h}" class="${cur === h || cur.startsWith(h + '/') ? 'on' : ''}">${l}</a>`)}</nav></aside>` : ''}
  <div class="content">
    ${flash ? html`<div class="notice ${flash.type === 'error' ? 'bad' : 'ok'}" role="status">${flash.msg}</div>` : ''}
    ${body}
  </div>
</main>
<footer class="foot"><div class="wrap">
  <p>이음마켓은 통신판매중개자이며 거래 당사자가 아닙니다. 상품·용역의 내용과 권리에 대한 책임은 판매자에게 있습니다</p>
  <p class="muted">파일 검사·실행 확인·권리 자료 확인은 각각 별개의 확인이며 어느 하나도 전체 품질이나 권리를 보증하지 않습니다 · <a href="/guide">안전거래 보호 범위와 한계</a></p>
</div></footer>
</body></html>`;
  return out.s;
}

module.exports = { html, raw, esc, nl2br, lines, bullets, label, badge, tag, hashChip, size, csrf, field, check, postBtn, table, dl, card, notice, page, won, fmtDate, bpsPct, LABELS, MY_NAV };
