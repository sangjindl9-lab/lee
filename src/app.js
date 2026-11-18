'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { q } = require('./db');
const { AppError } = require('./util');
const ui = require('./ui');
const accounts = require('./services/accounts');
const providers = require('./providers');
const webhooks = require('./services/webhooks');
const { html } = ui;

function build() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net; script-src 'self' https://js.tosspayments.com; frame-src https://*.tosspayments.com; connect-src 'self' https://*.tosspayments.com; frame-ancestors 'none'; form-action 'self'",
    });
    if (config.cookieSecure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '1h' : 0 }));
  app.get('/healthz', (req, res) => { q.get('SELECT 1'); res.json({ ok: true }); });

  // 웹훅: 서명 검증을 위해 원문 그대로 받는다(세션·CSRF 대상 아님).
  app.post('/webhooks/:provider', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    try { res.json(await webhooks.handle(req.params.provider, req.body.toString('utf8'), req.headers)); }
    catch (e) { res.status(e.status || 500).json({ error: e.code || 'ERROR' }); }
  });

  app.use(cookieParser());
  app.use(express.urlencoded({ extended: true, limit: '200kb' }));

  const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' };
  app.use((req, res, next) => {
    // CSRF: 쿠키 값과 폼 값을 비교(더블 서브밋)
    let token = req.cookies.eum_csrf;
    if (!token || !/^[0-9a-f]{32}$/.test(token)) { token = crypto.randomBytes(16).toString('hex'); res.cookie('eum_csrf', token, cookieOpts); }
    req.csrfToken = token;
    req.user = accounts.sessionUser(req.cookies.eum_sid);
    req.unread = req.user ? q.get('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL', req.user.id).c : 0;
    req.testMode = providers.active().mode === 'test';
    if (req.cookies.eum_flash) { try { req.flash = JSON.parse(req.cookies.eum_flash); } catch { /* 무시 */ } res.clearCookie('eum_flash', { path: '/' }); }
    res.flash = (msg, type = 'ok') => res.cookie('eum_flash', JSON.stringify({ msg: String(msg).slice(0, 600), type }), { ...cookieOpts, maxAge: 60000 });
    res.back = (fallback = '/') => {
      const ref = req.get('referer');
      let to = fallback;
      try { if (ref && new URL(ref).host === req.get('host')) to = new URL(ref).pathname + new URL(ref).search; } catch { /* 무시 */ }
      res.redirect(303, to);
    };
    res.page = (opts) => res.send(ui.page(req, opts));
    res.setSession = (token) => res.cookie('eum_sid', token, { ...cookieOpts, maxAge: 14 * 86400000 });
    next();
  });
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const sent = (req.body && req.body._csrf) || req.query._csrf;
    if (!sent || sent !== req.csrfToken) return next(new AppError('요청이 만료되었습니다. 페이지를 새로 고친 뒤 다시 시도하세요.', 403, 'CSRF'));
    next();
  });

  for (const name of ['auth', 'public', 'trade', 'community', 'seller', 'projects', 'ip', 'company', 'sandboxpg', 'admin']) {
    app.use(require('./routes/' + name));
  }

  app.use((req, res, next) => next(new AppError('페이지를 찾을 수 없습니다.', 404)));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    const msg = err.expose ? err.message : '처리 중 오류가 발생했습니다. 잠시 후 다시 시도하세요.';
    if (err.code === 'REAUTH_REQUIRED') return res.redirect('/reauth?next=' + encodeURIComponent(req.get('referer') ? new URL(req.get('referer')).pathname : '/my/account'));
    // 폼 제출 실패는 원래 화면으로 돌려보내 사유를 보여준다.
    if (req.method === 'POST' && status < 500 && req.get('referer') && res.flash) { res.flash(msg, 'error'); return res.back(); }
    res.status(status);
    if (!res.page) return res.send(msg);
    res.page({ title: '안내', body: html`<div class="card narrow"><h1>${status === 404 ? '찾을 수 없습니다' : '요청을 처리할 수 없습니다'}</h1><p class="sub">${msg}</p><a class="btn" href="/">홈으로</a></div>` });
  });
  return app;
}
module.exports = { build };
