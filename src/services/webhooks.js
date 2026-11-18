'use strict';
const { q } = require('../db');
const { clock, AppError } = require('../util');
const providers = require('../providers');
const orders = require('./orders');

// 웹훅 처리: 서명 검증 → 중복 제거 → 사업자에 현재 상태를 조회해 반영.
// 본문의 상태 값은 쓰지 않으므로 지연·역순 도착에도 결과가 같다.
async function handle(providerName, rawBody, headers) {
  const provider = providers.byName(providerName);
  if (!provider) throw new AppError('알 수 없는 사업자', 404);
  let ev;
  try { ev = provider.verifyWebhook(rawBody, headers); } catch (e) { throw new AppError('웹훅 검증 실패: ' + (e.code || e.message), 401, 'WEBHOOK_INVALID'); }
  const ins = q.run('INSERT OR IGNORE INTO webhook_events (provider, event_id, type, payload, occurred_at, received_at) VALUES (?,?,?,?,?,?)', providerName, ev.eventId, ev.type, rawBody, ev.occurredAt || null, clock.iso());
  const row = q.get('SELECT * FROM webhook_events WHERE provider = ? AND event_id = ?', providerName, ev.eventId);
  if (ins.changes === 0 && row.processed_at) return { status: 'duplicate' };
  let result = 'ignored';
  if (ev.providerPaymentId) {
    const pay = q.get('SELECT * FROM payments WHERE provider = ? AND provider_payment_id = ?', providerName, ev.providerPaymentId);
    if (pay) { await orders.syncPayment(pay.id); result = 'synced'; } else result = 'unknown_payment';
  }
  q.update('webhook_events', row.id, { processed_at: clock.iso(), result });
  return { status: 'processed', result };
}
module.exports = { handle };
