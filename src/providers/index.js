'use strict';
const config = require('../config');
const { q } = require('../db');
const sandbox = require('./sandbox');
const toss = require('./toss');

const providers = { sandbox, toss };
let override = null;
const active = () => override || providers[config.paymentProvider] || sandbox;
const byName = (name) => providers[name];

// 실결제 도입 전 확인 항목
const CHECK_ITEMS = [
  ['digital_goods', '디지털 상품 및 개발 용역 취급 가능 여부', true],
  ['marketplace', '다수 판매자가 입점하는 사업 구조 지원 여부', true],
  ['methods', '지원 결제수단', false],
  ['escrow_hold', '대금 보호 및 정산 구조', false],
  ['max_hold_days', '최대 보류 기간(일)', false],
  ['auto_confirm_days', '구매확정 및 자동확정 방식(자동확정까지 일수, 없으면 0)', false],
  ['dispute_hold', '분쟁 시 지급 중지 가능 범위', false],
  ['partial_refund_methods', '부분 환불 가능 조건(지원 결제수단, 쉼표 구분)', false],
  ['staged_payments', '단계별 결제 지원 여부', false],
  ['seller_kyc', '판매자 확인 절차', false],
  ['payout_api', '판매자 지급 API', false],
  ['refund_after_payout', '이미 지급한 거래의 환불 처리 방식', false],
];

// 실제로 켜도 되는 기능. 테스트 사업자는 스스로 밝힌 값을 쓰고,
// 실결제 사업자는 운영자가 확인표에 '지원'으로 기록한 항목만 켠다.
function caps() {
  const p = active();
  const d = p.declared();
  let c;
  if (p.mode === 'test') {
    c = { ...d };
  } else {
    const rows = Object.fromEntries(q.all('SELECT * FROM pg_capability_checks WHERE provider = ?', p.name).map((r) => [r.item, r]));
    const ok = (k) => rows[k]?.status === 'supported' && d[k] !== false;
    const num = (k) => (ok(k) && /^\d+$/.test(rows[k].value) ? Number(rows[k].value) : null);
    const list = (k) => (ok(k) ? rows[k].value.split(',').map((s) => s.trim()).filter(Boolean) : []);
    c = {
      digital_goods: ok('digital_goods'), marketplace: ok('marketplace'), methods: ok('methods') ? list('methods') : [],
      escrow_hold: ok('escrow_hold'), max_hold_days: ok('escrow_hold') ? num('max_hold_days') : null, auto_confirm_days: num('auto_confirm_days') || null,
      dispute_hold: ok('dispute_hold'), partial_refund_methods: list('partial_refund_methods'), staged_payments: ok('staged_payments'),
      seller_kyc: ok('seller_kyc'), payout_api: ok('payout_api'), refund_after_payout: ok('refund_after_payout'),
    };
  }
  c.provider = p.name; c.mode = p.mode;
  // 실결제 가능 조건: 필수 확인 항목이 모두 확인되고 운영자가 실결제 모드를 켰을 때
  c.checkout_enabled = p.mode === 'test' ? true : (c.digital_goods && c.marketplace && q.setting('live_mode') === '1');
  return c;
}
module.exports = { active, byName, caps, CHECK_ITEMS, setForTest: (p) => { override = p; } };
