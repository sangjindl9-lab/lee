'use strict';
// 토스페이먼츠 어댑터 — 결제 승인·조회·취소만 구현.
// ※ 이 코드는 공개 문서의 v1 결제 API 형식에 맞춰 작성했으나 실제 가맹점 계정으로 검증하지 않았다.
//   계약·심사 후 테스트 키로 docs/05의 점검 절차를 통과하기 전에는 운영에 쓰지 않는다.
// ※ 대금 보류(에스크로), 판매자 지급(지급대행), 분쟁 시 지급 중지는 구현하지 않았다.
//   → declared()에서 false로 밝히며, 플랫폼은 "대금 보호 미적용 · 수동 지급 절차"로 동작한다.
const config = require('../config');

class ProviderError extends Error {
  constructor(code, message, { unknown = false } = {}) { super(message || code); this.code = code; this.unknown = unknown; }
}
const API = 'https://api.tosspayments.com/v1';
const auth = () => 'Basic ' + Buffer.from(config.tossSecretKey + ':').toString('base64');

async function call(method, path, body, idem) {
  let res;
  try {
    res = await fetch(API + path, {
      method, signal: AbortSignal.timeout(15000),
      headers: { Authorization: auth(), 'Content-Type': 'application/json', ...(idem ? { 'Idempotency-Key': idem } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { throw new ProviderError('TIMEOUT', '결제 사업자 응답 없음: ' + e.message, { unknown: true }); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(json.code || 'HTTP_' + res.status, json.message || '결제 사업자 오류', { unknown: res.status >= 500 });
  return json;
}
const METHOD = { 카드: 'card', 계좌이체: 'transfer', 가상계좌: 'vbank', 간편결제: 'easypay', 휴대폰: 'mobile' };
function normalize(p) {
  const cancelled = (p.cancels || []).reduce((s, c) => s + c.cancelAmount, 0);
  const map = { READY: 'pending', IN_PROGRESS: 'pending', WAITING_FOR_DEPOSIT: 'pending', DONE: 'paid', CANCELED: 'refunded', PARTIAL_CANCELED: 'partially_refunded', ABORTED: 'failed', EXPIRED: 'failed' };
  return {
    status: map[p.status] || 'pending', rawStatus: p.status, amount: p.totalAmount, refunded: cancelled,
    method: METHOD[p.method] || p.method || '', fee: null, paidAt: p.approvedAt ? new Date(p.approvedAt).toISOString() : null,
    escrow: { state: 'NONE', holdUntil: null, autoConfirmAt: null }, payable: null, paidOut: null,
  };
}

module.exports = {
  name: 'toss', mode: 'live', ProviderError,
  declared() {
    return {
      digital_goods: null, marketplace: null, methods: ['card', 'transfer', 'vbank', 'easypay'],
      escrow_hold: false, max_hold_days: null, auto_confirm_days: null, dispute_hold: false,
      partial_refund_methods: null, staged_payments: null, seller_kyc: false, payout_api: false, refund_after_payout: false,
    };
  },
  // 결제창은 브라우저 SDK가 띄운다. 서버는 주문번호·금액을 고정해 내려주고, 성공 URL에서 승인 API를 호출한다.
  async createPayment({ orderNo }) { return { providerPaymentId: null, redirectUrl: `/pay/toss/${orderNo}` }; },
  async confirm({ paymentKey, orderId, amount }) { return normalize(await call('POST', '/payments/confirm', { paymentKey, orderId, amount }, 'confirm_' + orderId)); },
  async getPayment(paymentKey) { return normalize(await call('GET', '/payments/' + encodeURIComponent(paymentKey))); },
  async cancelPayment({ providerPaymentId, amount, idempotencyKey, reason }) {
    await call('POST', `/payments/${encodeURIComponent(providerPaymentId)}/cancel`, { cancelReason: reason || '환불', cancelAmount: amount }, idempotencyKey);
    return { status: 'done', refundId: idempotencyKey };
  },
  async setPayoutHold() { return { result: 'unsupported' }; },
  async requestPayout() { throw new ProviderError('UNSUPPORTED', '지급 API가 연동되어 있지 않습니다.'); },
  async getPayout() { return { status: 'not_found' }; },
  // 결제 상태 웹훅에는 서명이 없으므로 본문을 신뢰하지 않고, 받은 paymentKey로 결제 조회 API를 호출해 확인한다.
  verifyWebhook(rawBody) {
    const b = JSON.parse(rawBody);
    const key = b?.data?.paymentKey;
    if (!key) throw new ProviderError('UNSUPPORTED_EVENT');
    return { eventId: `${b.eventType}:${key}:${b.createdAt}:${b.data.status}`, type: b.eventType, providerPaymentId: key, occurredAt: b.createdAt };
  },
};
