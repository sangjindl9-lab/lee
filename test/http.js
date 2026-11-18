'use strict';
// HTTP 수준 시험용 클라이언트(쿠키·CSRF 처리). helper.js를 먼저 require 해야 한다.
const accounts = require('../src/services/accounts');
let server;
async function start() {
  if (server) return server;
  const app = require('../src/app').build();
  server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  server.unref();
  return server;
}
function client(user) {
  const jar = {};
  if (user) jar.eum_sid = accounts.createSession(user.id);
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res) => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); if (v) jar[kv.slice(0, i)] = v; else delete jar[kv.slice(0, i)]; } };
  const base = () => `http://127.0.0.1:${server.address().port}`;
  const api = {
    jar,
    async get(path) { await start(); const res = await fetch(base() + path, { headers: { cookie: cookie() }, redirect: 'manual' }); store(res); return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers }; },
    async post(path, body = {}) {
      await start();
      if (!jar.eum_csrf) await api.get('/healthz-csrf');   // 아무 페이지나 요청해 CSRF 쿠키를 받는다
      const res = await fetch(base() + path, { method: 'POST', redirect: 'manual', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded', referer: base() + '/' }, body: new URLSearchParams({ _csrf: jar.eum_csrf, ...body }) });
      store(res);
      let flash = null; if (jar.eum_flash) { try { flash = JSON.parse(decodeURIComponent(jar.eum_flash)); } catch { /* 무시 */ } delete jar.eum_flash; }
      return { status: res.status, location: res.headers.get('location'), text: await res.text(), flash };
    },
  };
  return api;
}
module.exports = { start, client };
