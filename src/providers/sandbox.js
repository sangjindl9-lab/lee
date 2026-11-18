'use strict';
// 내장 테스트 결제 사업자. 실제 돈은 이동하지 않으며 대금 보호도 없다.
// 실제 사업자의 동작(보류, 부분취소 제한, 지급 멱등성, 서명된 웹훅, 타임아웃)을 흉내 내
// 플랫폼 로직을 검증하는 용도다. 자체 장부(sandbox_* 테이블)를 따로 가진다.
const crypto = require('crypto');
const config = require('../config');
const { q } = require('../db');
const { clock, addDays, randomId, bpsOf } = require('../util');

class ProviderError extends Error {
  constructor(code, message, { unknown = false } = {}) { super(message || code); this.code = code; this.unknown = unknown; }
}

const state = {
  maxHoldDays: 30, autoConfirmDays: null, disputeHold: true, stagedPayments: true, payoutApi: true,
  partialRefundMethods: ['card', 'transfer'],     // 가상계좌(vbank)는 부분취소 미지원으로 흉내
  methods: ['card', 'transfer', 'vbank'],
  feeBps: 330,
  faults: {},            // payoutTimeout | payoutTimeoutNotProcessed | payoutFail | cancelFail | cancelTimeout | holdFail | delayMs
  holdWebhooks: false,   // true면 웹훅을 보내지 않고 outbox에 쌓는다(지연·역순 시험용)
  outbox: [],
  deliver: null,         // (rawBody, headers) => Promise — 앱이 등록
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const delay = () => (state.faults.delayMs ? sleep(state.faults.delayMs) : Promise.resolve());

function sign(rawBody, ts = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', config.sandboxWebhookSecret).update(`${ts}.${rawBody}`).digest('hex');
  return { 'x-sandbox-timestamp': String(ts), 'x-sandbox-signature': sig };
}
function buildEvent(type, paymentId, extra = {}) {
  const rawBody = JSON.stringify({ id: 'evt_' + randomId(8), type, paymentId, occurredAt: clock.iso(), ...extra });
  return { rawBody, headers: sign(rawBody) };
}
async function emit(type, paymentId, extra) {
  const ev = buildEvent(type, paymentId, extra);
  if (state.holdWebhooks || !state.deliver) { state.outbox.push(ev); return; }
  try { await state.deliver(ev.rawBody, ev.headers); } catch { state.outbox.push(ev); }
}
const row = (id) => q.get('SELECT * FROM sandbox_payments WHERE id = ?', id);
const paidOut = (id) => q.get("SELECT COALESCE(SUM(amount),0) s FROM sandbox_payouts WHERE payment_id = ? AND status IN ('ACCEPTED','PAID')", id).s;

const provider = {
  name: 'sandbox', mode: 'test', ProviderError, state,

  // 사업자가 스스로 밝히는 기능. 테스트 사업자이므로 별도 계약 확인 없이 사용한다.
  declared() {
    return {
      digital_goods: true, marketplace: true, methods: state.methods, escrow_hold: true, max_hold_days: state.maxHoldDays,
      auto_confirm_days: state.autoConfirmDays, dispute_hold: state.disputeHold, partial_refund_methods: state.partialRefundMethods,
      staged_payments: state.stagedPayments, seller_kyc: true, payout_api: state.payoutApi, refund_after_payout: false,
    };
  },

  async createPayment({ orderNo, amount }) {
    const id = 'sbx_' + randomId(10);
    q.insert('sandbox_payments', { id, order_no: orderNo, amount, status: 'READY', created_at: clock.iso() });
    return { providerPaymentId: id, redirectUrl: `/sandbox-pg/pay/${id}` };
  },

  // 테스트 결제창에서 호출: 결제 성공/실패를 흉내 낸다.
  async simulate(id, { result = 'success', method = 'card' } = {}) {
    const p = row(id);
    if (!p || p.status !== 'READY') throw new ProviderError('INVALID_STATE', '이미 처리된 결제입니다.');
    if (result === 'success') {
      const now = clock.iso();
      q.update('sandbox_payments', id, { status: 'PAID', method, paid_at: now, escrow: 'HELD', hold_until: addDays(now, state.maxHoldDays), fee: bpsOf(p.amount, state.feeBps) });
      await emit('payment.paid', id);
    } else {
      q.update('sandbox_payments', id, { status: 'FAILED', method });
      await emit('payment.failed', id);
    }
  },

  async getPayment(id) {
    await delay();
    const p = row(id);
    if (!p) throw new ProviderError('NOT_FOUND');
    const map = { READY: 'pending', PAID: 'paid', FAILED: 'failed', CANCELLED: 'refunded', PARTIAL_CANCELLED: 'partially_refunded' };
    return {
      status: map[p.status], rawStatus: p.status, amount: p.amount, refunded: p.refunded, method: p.method, fee: p.fee, paidAt: p.paid_at,
      escrow: { state: p.escrow, holdUntil: p.hold_until, autoConfirmAt: state.autoConfirmDays && p.paid_at ? addDays(p.paid_at, state.autoConfirmDays) : null },
      payable: p.amount - p.refunded - paidOut(id), paidOut: paidOut(id),
    };
  },

  async cancelPayment({ providerPaymentId: id, amount, idempotencyKey }) {
    await delay();
    if (state.faults.cancelFail) throw new ProviderError('CANCEL_REJECTED', '사업자가 취소를 거절했습니다.');
    const p = row(id);
    const dup = q.get('SELECT * FROM sandbox_refunds WHERE idem = ?', idempotencyKey);
    if (dup) return { status: 'done', refundId: 'sbr_' + idempotencyKey };
    if (!p || !['PAID', 'PARTIAL_CANCELLED'].includes(p.status)) throw new ProviderError('INVALID_STATE', '취소할 수 없는 결제 상태입니다.');
    const partial = amount < p.amount - p.refunded || p.refunded > 0;
    if (partial && amount < p.amount && !state.partialRefundMethods.includes(p.method)) throw new ProviderError('PARTIAL_REFUND_UNSUPPORTED', '이 결제수단은 부분 취소를 지원하지 않습니다.');
    if (amount > p.amount - p.refunded - paidOut(id)) throw new ProviderError('ALREADY_SETTLED', '이미 지급된 금액은 일반 취소로 되돌릴 수 없습니다.');
    q.tx(() => {
      q.insert('sandbox_refunds', { idem: idempotencyKey, payment_id: id, amount, created_at: clock.iso() });
      const refunded = p.refunded + amount;
      q.update('sandbox_payments', id, { refunded, status: refunded >= p.amount ? 'CANCELLED' : 'PARTIAL_CANCELLED' });
    });
    if (state.faults.cancelTimeout) throw new ProviderError('TIMEOUT', '응답 시간 초과', { unknown: true });
    await emit('payment.cancelled', id);
    return { status: 'done', refundId: 'sbr_' + idempotencyKey };
  },

  async setPayoutHold({ providerPaymentId: id, hold }) {
    if (!state.disputeHold) return { result: 'unsupported' };
    if (state.faults.holdFail) throw new ProviderError('HOLD_FAILED', '보류 요청 실패');
    const p = row(id);
    if (!p || p.escrow === 'RELEASED') return { result: 'failed', detail: '이미 지급되어 보류할 수 없습니다.' };
    q.update('sandbox_payments', id, { escrow: hold ? 'PAYOUT_BLOCKED' : 'HELD' });
    return { result: 'confirmed' };
  },

  async requestPayout({ idempotencyKey, providerPaymentId: id, amount }) {
    await delay();
    if (state.faults.payoutTimeoutNotProcessed) throw new ProviderError('TIMEOUT', '응답 시간 초과', { unknown: true });
    if (state.faults.payoutFail) throw new ProviderError('PAYOUT_REJECTED', '사업자가 지급을 거절했습니다.');
    const dup = q.get('SELECT * FROM sandbox_payouts WHERE idem = ?', idempotencyKey);
    if (!dup) {
      const p = row(id);
      if (!p) throw new ProviderError('NOT_FOUND');
      if (p.escrow === 'PAYOUT_BLOCKED') throw new ProviderError('PAYOUT_BLOCKED', '지급이 보류된 결제입니다.');
      if (amount > p.amount - p.refunded - paidOut(id)) throw new ProviderError('INSUFFICIENT_BALANCE', '지급 가능 잔액이 부족합니다.');
      q.insert('sandbox_payouts', { idem: idempotencyKey, id: 'sbo_' + randomId(8), payment_id: id, amount, status: 'ACCEPTED', created_at: clock.iso() });
    }
    if (state.faults.payoutTimeout) throw new ProviderError('TIMEOUT', '응답 시간 초과', { unknown: true });
    const po = q.get('SELECT * FROM sandbox_payouts WHERE idem = ?', idempotencyKey);
    return { status: po.status === 'PAID' ? 'paid' : 'accepted', providerPayoutId: po.id };
  },

  // 조회 시점에 접수된 지급을 완료 처리한다(은행 이체가 끝난 것을 흉내).
  async getPayout({ idempotencyKey }) {
    await delay();
    const po = q.get('SELECT * FROM sandbox_payouts WHERE idem = ?', idempotencyKey);
    if (!po) return { status: 'not_found' };
    if (po.status === 'ACCEPTED') {
      q.run("UPDATE sandbox_payouts SET status = 'PAID' WHERE idem = ?", idempotencyKey);
      q.run("UPDATE sandbox_payments SET escrow = 'RELEASED' WHERE id = ?", po.payment_id);
      return { status: 'paid', providerPayoutId: po.id };
    }
    return { status: po.status === 'PAID' ? 'paid' : 'failed', providerPayoutId: po.id };
  },

  verifyWebhook(rawBody, headers) {
    const ts = Number(headers['x-sandbox-timestamp']), sig = String(headers['x-sandbox-signature'] || '');
    if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) throw new ProviderError('BAD_TIMESTAMP');
    const expect = crypto.createHmac('sha256', config.sandboxWebhookSecret).update(`${ts}.${rawBody}`).digest('hex');
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) throw new ProviderError('BAD_SIGNATURE');
    const b = JSON.parse(rawBody);
    return { eventId: b.id, type: b.type, providerPaymentId: b.paymentId, payoutIdem: b.payoutIdem, occurredAt: b.occurredAt };
  },

  // 시험 도구
  buildEvent, sign,
  async flushOutbox() { const evs = state.outbox.splice(0); for (const e of evs) await state.deliver(e.rawBody, e.headers); return evs.length; },
  resetForTest() {
    Object.assign(state, { maxHoldDays: 30, autoConfirmDays: null, disputeHold: true, stagedPayments: true, payoutApi: true, partialRefundMethods: ['card', 'transfer'], faults: {}, holdWebhooks: false, outbox: [] });
  },
};
module.exports = provider;
