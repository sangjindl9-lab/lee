'use strict';
const r = require('express').Router();
const { h, needUser } = require('../web');
const { html, csrf, field, card, notice } = require('../ui');
const accounts = require('../services/accounts');
const { audit } = require('../log');

const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)/.test(n) ? n : '/');

r.get('/signup', (req, res) => res.page({ title: '회원가입', body: html`<div class="narrow"><h1>회원가입</h1>
  <p class="sub">한 계정으로 구매와 판매를 모두 할 수 있습니다</p>
  <form method="post" action="/signup" class="card">${csrf(req)}
    ${field('이메일', 'email', '', { type: 'email', required: true })}${field('이름', 'name', '', { required: true })}
    ${field('연락처', 'phone', '', { hint: '거래 알림과 분쟁 처리 연락에만 사용합니다' })}
    ${field('비밀번호', 'password', '', { type: 'password', required: true, hint: '10자 이상' })}
    <button class="btn primary block">가입하기</button></form>
  <p class="muted">이미 계정이 있다면 <a href="/login">로그인</a></p></div>` }));
r.post('/signup', h(async (req, res) => {
  const u = accounts.register(req.body);
  res.setSession(accounts.createSession(u.id));
  res.redirect('/');
}));

r.get('/login', (req, res) => res.page({ title: '로그인', body: html`<div class="narrow"><h1>로그인</h1>
  <form method="post" action="/login" class="card">${csrf(req)}<input type="hidden" name="next" value="${req.query.next || ''}">
    ${field('이메일', 'email', '', { type: 'email', required: true })}${field('비밀번호', 'password', '', { type: 'password', required: true })}
    <button class="btn primary block">로그인</button></form>
  <p class="muted">계정이 없다면 <a href="/signup">회원가입</a></p></div>` }));
r.post('/login', h(async (req, res) => {
  const u = accounts.login(req.body.email, req.body.password, req.ip);
  res.setSession(accounts.createSession(u.id));
  audit({ id: u.id }, 'login', 'user', u.id, {}, req.ip);
  res.redirect(safeNext(req.body.next));
}));
r.post('/logout', (req, res) => { if (req.cookies.eum_sid) accounts.destroySession(req.cookies.eum_sid); res.clearCookie('eum_sid', { path: '/' }); res.redirect('/'); });

// 민감 작업 전 비밀번호 재확인
r.get('/reauth', needUser, (req, res) => res.page({ title: '비밀번호 확인', body: html`<div class="narrow"><h1>비밀번호 확인</h1>
  <p class="sub">정산 계좌 변경 같은 민감한 작업 전에 본인 확인을 다시 합니다</p>
  <form method="post" action="/reauth" class="card">${csrf(req)}<input type="hidden" name="next" value="${req.query.next || ''}">
    ${field('비밀번호', 'password', '', { type: 'password', required: true })}<button class="btn primary block">확인</button></form></div>` }));
r.post('/reauth', needUser, h(async (req, res) => { accounts.reauth(req.user, req.body.password); res.flash('본인 확인이 완료되었습니다. 10분 안에 작업을 다시 진행하세요'); res.redirect(safeNext(req.body.next)); }));

// 운영자 추가 인증(TOTP)
r.get('/admin/mfa', needUser, (req, res, next) => {
  if (!req.user.staff.length) return next();
  let setup = '';
  if (!req.user.totp_enabled) {
    const t = accounts.totpBegin(req.user);
    setup = html`${notice('인증 앱(Google Authenticator 등)에 아래 키를 등록한 뒤 6자리 코드를 입력하세요. 이 키는 다시 표시되지 않습니다')}
      <p><code class="hash">${t.secret}</code></p><p class="hint">${t.uri}</p>`;
  }
  res.page({ title: '운영자 추가 인증', body: html`<div class="narrow"><h1>운영자 추가 인증</h1>${card('', html`${setup}
    <form method="post" action="/admin/mfa">${csrf(req)}${field('인증 코드', 'code', '', { required: true, attrs: 'inputmode="numeric" autocomplete="one-time-code"' })}<button class="btn primary block">인증</button></form>`)}</div>` });
});
r.post('/admin/mfa', needUser, h(async (req, res) => { accounts.totpVerify(req.user, req.body.code); res.redirect('/admin'); }));

module.exports = r;
