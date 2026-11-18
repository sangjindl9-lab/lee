'use strict';
const { q } = require('../db');
const { clock } = require('../util');

// 주기 작업 한 바퀴. 각 단계는 여러 번 실행해도 안전하다.
async function runAll() {
  const out = {};
  const step = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = 'ERROR: ' + e.message; console.error('[job]', name, e); } };
  await step('retryAccess', () => require('./orders').retryAccess());
  await step('inspection', () => require('./inspection').tick());
  await step('refunds', () => require('./refunds').tick());
  await step('settlement', () => require('./settlement').tick());
  await step('reconcile', async () => (await require('./reconcile').run()).issues.length);
  await step('cleanup', () => q.run('DELETE FROM download_tokens WHERE expires_at < ?', new Date(clock.now() - 86400000).toISOString()).changes
    + q.run('DELETE FROM sessions WHERE expires_at < ?', clock.iso()).changes);
  return out;
}
function start(intervalMs = 5 * 60000) {
  const t = setInterval(() => runAll().catch((e) => console.error(e)), intervalMs);
  t.unref();
  return t;
}
module.exports = { runAll, start };
