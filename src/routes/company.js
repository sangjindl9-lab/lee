'use strict';
// 기업 계정 화면
const r = require('express').Router();
const { h, needUser } = require('../web');
const { html, csrf, field, card, notice, badge, tag, won, fmtDate, table, postBtn } = require('../ui');
const { int } = require('../util');
const company = require('../services/company');

const AP = { pending: ['승인 대기', 'warn'], approved: ['승인 — 주문 가능', 'ok'], rejected: ['반려', 'bad'], used: ['주문에 사용됨', ''] };

r.get('/my/company', needUser, (req, res) => {
  const list = company.mine(req.user);
  res.page({ title: '기업 계정', my: true, body: html`<div class="head"><div><h1>기업 계정</h1><p class="sub">구매 담당자가 요청하고 관리자가 승인한 뒤 주문하며, 검수 담당자가 납품물을 확인합니다</p></div></div>
    ${list.length ? list.map((c) => {
      const isAdmin = c.role === 'admin';
      const ms = company.members(c.id), aps = company.approvals(c.id), os = company.companyOrders(c.id);
      return html`${card(html`${c.name} ${tag(company.ROLES[c.role])}`, html`
        <p class="sub">${c.biz_no ? `사업자등록번호 ${c.biz_no} · ` : ''}구매 승인 ${c.require_approval ? '필요(관리자 본인 구매 제외)' : '불필요'}</p>
        ${isAdmin ? postBtn(req, `/my/company/${c.id}/approval-setting`, c.require_approval ? '구매 승인 절차 끄기' : '구매 승인 절차 켜기', { cls: 'sm', fields: { on: c.require_approval ? '0' : '1' } }) : ''}
        <h3>구성원</h3>
        ${table(['이름', '이메일', '권한', ''], ms.map((m) => [m.name, isAdmin ? m.email : '-', company.ROLES[m.role], isAdmin ? html`<div class="actions">
          <form method="post" action="/my/company/${c.id}/members/${m.user_id}/role" class="inline">${csrf(req)}<select name="role">${Object.entries(company.ROLES).map(([k, l]) => html`<option value="${k}" ${k === m.role ? html`selected` : ''}>${l}</option>`)}</select> <button class="btn sm">변경</button></form>
          ${postBtn(req, `/my/company/${c.id}/members/${m.user_id}/remove`, '제거', { cls: 'sm danger' })}</div>` : '']))}
        ${isAdmin ? html`<form method="post" action="/my/company/${c.id}/members" class="row mt">${csrf(req)}
          ${field('추가할 회원 이메일', 'email', '', { type: 'email', required: true })}${field('권한', 'role', 'buyer', { options: Object.entries(company.ROLES) })}
          <div class="field"><label>&nbsp;</label><button class="btn">구성원 추가</button></div></form>` : ''}
        <h3>구매 승인</h3>
        ${table(['요청일', '요청자', '상품', '금액', '상태', ''], aps.map((a) => [fmtDate(a.created_at, false), a.requester, html`<a href="/products/${a.product_id}">${a.title}</a><br><span class="muted">${a.option_name}${a.note ? ` · ${a.note}` : ''}</span>`, won(a.price), tag(...AP[a.status]),
          isAdmin && a.status === 'pending' ? html`<div class="actions">${postBtn(req, `/my/company/approvals/${a.id}`, '승인', { cls: 'sm primary', fields: { approve: '1' } })}${postBtn(req, `/my/company/approvals/${a.id}`, '반려', { cls: 'sm', fields: { approve: '0' } })}</div>` : '']), '구매 승인 요청이 없습니다')}
        <h3>기업 주문</h3>
        ${table(['주문', '주문자', '금액', '결제', '검수'], os.map((o) => [c.role === 'buyer' && o.buyer_id !== req.user.id ? html`${o.title}<br><span class="muted">${o.order_no}</span>` : html`<a href="/my/orders/${o.id}">${o.title}</a><br><span class="muted">${o.order_no}</span>`, o.buyer_name, won(o.amount), badge('payment', o.payment_status), badge('inspection', o.inspection_status)]), '기업 계정으로 주문한 내역이 없습니다')}`)}`;
    }) : notice('소속된 기업 계정이 없습니다. 아래에서 새로 만들거나, 기업 관리자에게 가입한 이메일을 알려 구성원으로 추가받으세요')}
    ${card('기업 계정 만들기', html`<form method="post" action="/my/company">${csrf(req)}<div class="row">${field('기업 이름', 'name', '', { required: true })}${field('사업자등록번호(선택)', 'biz_no', '')}</div><button class="btn">만들기</button></form>
      <p class="hint">만든 사람이 관리자가 됩니다. 사업자 정보는 플랫폼이 진위를 확인하지 않습니다</p>`)}` });
});
r.post('/my/company', needUser, h(async (req, res) => { company.create(req.user, { name: req.body.name, bizNo: req.body.biz_no }); res.flash('기업 계정을 만들었습니다'); res.redirect(303, '/my/company'); }));
r.post('/my/company/approvals', needUser, h(async (req, res) => {
  company.requestApproval(req.user, { companyId: req.body.company_id, productId: req.body.product_id, optionId: req.body.option_id, note: req.body.note });
  res.flash('구매 승인을 요청했습니다. 관리자가 승인하면 주문할 수 있습니다'); res.back('/my/company');
}));
r.post('/my/company/approvals/:id', needUser, h(async (req, res) => { company.decideApproval(req.user, int(req.params.id), req.body.approve === '1'); res.flash('처리했습니다'); res.back('/my/company'); }));
r.post('/my/company/:id/members', needUser, h(async (req, res) => { company.addMember(req.user, int(req.params.id), { email: req.body.email, role: req.body.role }); res.flash('구성원을 추가했습니다'); res.back('/my/company'); }));
r.post('/my/company/:id/members/:uid/role', needUser, h(async (req, res) => { company.setRole(req.user, int(req.params.id), int(req.params.uid), req.body.role); res.flash('권한을 변경했습니다'); res.back('/my/company'); }));
r.post('/my/company/:id/members/:uid/remove', needUser, h(async (req, res) => { company.removeMember(req.user, int(req.params.id), int(req.params.uid)); res.flash('구성원을 제거했습니다'); res.back('/my/company'); }));
r.post('/my/company/:id/approval-setting', needUser, h(async (req, res) => { company.setRequireApproval(req.user, int(req.params.id), req.body.on === '1'); res.flash('설정을 변경했습니다'); res.back('/my/company'); }));

module.exports = r;
