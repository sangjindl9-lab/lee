'use strict';
// 판매자 과세 유형별 세무·증빙 처리.
//  - general(법인·일반과세자): 플랫폼 수수료에 대한 세금계산서 기초 데이터(공급가액 + 부가세 10%)
//  - simplified(간이과세자): 세금계산서 수수 대상 여부를 구분해 기록
//  - individual(개인·비사업자): 지급액 기준 사업소득 원천징수(소득세 3% + 지방소득세 = 소득세의 10%) 공제, 지급명세서 기초 데이터
// 실제 세금계산서 발행·원천세 신고·지급명세서 제출은 외부 절차이며 여기서는 금액 계산과 기초 데이터만 만든다.
// 세율·절사·소액부징수 기준은 운영 설정으로 두었고, 적용 전 세무 검토가 필요하다.
const { q } = require('../db');
const { clock } = require('../util');

const floor10 = (n) => Math.floor(n / 10) * 10;      // 세액 10원 미만 절사

function withholding(sellerId, gross) {
  const sp = q.get('SELECT tax_type FROM seller_profiles WHERE user_id = ?', sellerId);
  const taxType = sp?.tax_type || 'individual';
  let income = 0, local = 0;
  if (taxType === 'individual' && q.setting('withholding_enabled') === '1' && gross > 0) {
    income = floor10(Math.floor((gross * q.settingInt('withholding_income_bps')) / 10000));
    if (income < q.settingInt('withholding_min_tax')) income = 0;
    local = floor10(Math.floor((income * q.settingInt('withholding_local_pct')) / 100));
  }
  return { taxType, income, local, total: income + local, net: gross - income - local };
}

// 수수료의 공급가액·부가세 구분(주문에 고정된 부가세 포함 여부 기준으로 저장된 fee_vat 비율을 그대로 쓴다)
function feeSplit(order, feeCharged) {
  const vat = order.fee_amount > 0 ? Math.floor((feeCharged * order.fee_vat) / order.fee_amount) : 0;
  return { supply: feeCharged - vat, vat };
}

const kstPeriod = (iso) => new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(0, 7);

// 지급 완료 시 증빙 기초 데이터 생성(같은 지급에 대해 한 번만)
function recordForPayout(payoutId) {
  const p = q.get('SELECT * FROM payouts WHERE id = ?', payoutId);
  if (!p || p.status !== 'paid') return;
  const o = q.get('SELECT * FROM orders WHERE id = ?', p.order_id);
  const sp = q.get('SELECT * FROM seller_profiles WHERE user_id = ?', p.seller_id);
  const taxType = p.tax_type || sp?.tax_type || 'individual';
  const feeCharged = -q.get("SELECT COALESCE(SUM(amount),0) s FROM ledger_entries WHERE order_id = ? AND account = 'platform_fee'", o.id).s;
  const { supply, vat } = feeSplit(o, feeCharged);
  const invoice = taxType === 'general' || (taxType === 'simplified' && sp?.simplified_invoice_ok);
  const base = { payout_id: p.id, order_id: o.id, seller_id: p.seller_id, seller_tax_type: taxType, period: kstPeriod(p.paid_at || clock.iso()), created_at: clock.iso() };
  const ins = (row) => { const k = Object.keys(row); q.run(`INSERT OR IGNORE INTO tax_records (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`, ...k.map((x) => row[x])); };
  if (feeCharged > 0) ins({ ...base, doc_type: invoice ? 'fee_tax_invoice' : 'fee_record', base_amount: feeCharged, supply_amount: supply, vat_amount: vat });
  if (p.withholding_income + p.withholding_local > 0) ins({ ...base, doc_type: 'withholding', base_amount: p.gross_amount, income_tax: p.withholding_income, local_tax: p.withholding_local });
}

function markIssued(admin, recordId, ref) {
  q.update('tax_records', recordId, { status: 'issued', issued_ref: String(ref || '').slice(0, 100), issued_by: admin.id, issued_at: clock.iso() });
  require('../log').audit(admin, 'tax.issued', 'tax_record', recordId, { ref });
}
module.exports = { withholding, feeSplit, recordForPayout, markIssued };
