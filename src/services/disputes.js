'use strict';
// 분쟁. 내부 정산 보류와 외부(결제 사업자) 지급 보류를 따로 기록한다.
// 결정은 사람이 내린다(운영자 또는 양측 합의). 자동·AI 판단 경로는 없다.
const { q } = require('../db');
const { clock, addDays, must, forbidden, str, AppError } = require('../util');
const providers = require('../providers');
const orders = require('./orders');
const { audit, notify, notifyStaff } = require('../log');

const REASONS = {
  no_delivery: '납품 기한 초과·미납품', missing_files: '필수 파일 누락', wrong_files: '빈 파일 또는 엉뚱한 파일',
  no_source: '소스 제공 조건인데 소스가 없음', not_as_described: '설명과 주요 기능 불일치', env_failure: '약속한 환경에서 실행 불가',
  undisclosed_costs: '미고지 추가 비용', rights_infringement: '권리 침해 의심',
  inspection_delay: '검수 지연(판매자 제기)', out_of_scope_demand: '계약 밖 요구(판매자 제기)', unjust_refund: '부당한 환불 요구(판매자 제기)', other: '기타',
};
const OUTCOMES = { refund_full: '전액 환불', refund_partial: '부분 환불', resume: '수정 후 거래 재개', release: '판매자 정산 진행', external: '외부 해결 절차 안내' };
const EXTERNAL_GUIDE = '플랫폼의 결정은 당사자의 법적 권리를 제한하지 않습니다. 전자문서·전자거래분쟁조정위원회, 콘텐츠분쟁조정위원회, 한국저작권위원회 조정, 한국소비자원, 법원 절차를 이용할 수 있습니다.';

const getDispute = (id) => q.get('SELECT * FROM disputes WHERE id = ?', id);
const entry = (disputeId, user, kind, body, extra = {}) => q.insert('dispute_entries', { dispute_id: disputeId, user_id: user.id, kind, body: str(body), created_at: clock.iso(), ...extra });

async function open(user, orderId, { reasonCode, description, requestedOutcome }) {
  const { order: o, role } = orders.loadFor(user, orderId);
  must(REASONS[reasonCode], '문제 유형을 선택하세요.');
  must(str(description).length >= 10, '문제 내용을 구체적으로 적어 주세요(10자 이상).');
  must(['paid', 'partially_refunded'].includes(o.payment_status), '결제가 확인된 주문만 문제 제기를 할 수 있습니다.', 409);
  must(!q.get("SELECT 1 FROM disputes WHERE order_id = ? AND status IN ('open','admin_review','appealed')", o.id), '이미 진행 중인 분쟁이 있습니다.', 409);
  const wantsRefund = role === 'buyer' && ['refund_full', 'refund_partial'].includes(requestedOutcome);
  let id, postPayout = false;
  q.txi(() => {
    const cur = orders.getOrder(o.id);
    postPayout = cur.payout_status === 'paid';
    const inFlight = ['requested', 'unknown'].includes(cur.payout_status);
    id = q.insert('disputes', { order_id: o.id, opened_by: user.id, reason_code: reasonCode, description: str(description), requested_outcome: OUTCOMES[requestedOutcome] ? requestedOutcome : '', post_payout: postPayout ? 1 : 0, created_at: clock.iso() });
    q.update('orders', o.id, {
      dispute_status: 'open',
      refund_status: wantsRefund && ['none', 'rejected', 'failed'].includes(cur.refund_status) ? 'requested' : cur.refund_status,
      // 이미 지급된 거래는 보류로 되돌릴 수 없다 → 사후 검토로 연결
      payout_status: postPayout ? 'clawback_review' : inFlight ? cur.payout_status : 'held',
    });
  });
  // 외부 보류: 가능 여부와 결과를 내부 상태와 별도로 남긴다.
  let hold = 'unsupported', detail = '결제 사업자가 분쟁 시 지급 중지를 지원하지 않거나 확인되지 않았습니다. 플랫폼의 정산 요청만 보류됩니다.';
  if (postPayout) { hold = 'not_applicable'; detail = '이미 판매자에게 지급된 거래입니다. 지급 보류 대상이 아니며 사후 환불·회수 검토로 진행합니다.'; }
  else if (providers.caps().dispute_hold) {
    const pay = q.get("SELECT * FROM payments WHERE order_id = ? AND status = 'paid'", o.id);
    try {
      const r = await providers.byName(pay.provider).setPayoutHold({ providerPaymentId: pay.provider_payment_id, hold: true });
      hold = r.result; detail = r.detail || (r.result === 'confirmed' ? '결제 사업자가 지급 보류를 확인했습니다.' : '');
    } catch (e) { hold = 'failed'; detail = '결제 사업자 보류 요청 실패: ' + e.message; }
  }
  q.update('disputes', id, { external_hold: hold, external_hold_detail: detail });
  q.run("UPDATE protection_records SET hold_request = ? WHERE order_id = ?", hold, o.id);
  audit(user, 'dispute.open', 'dispute', id, { order_id: o.id, reasonCode, external_hold: hold });
  const other = role === 'buyer' ? o.seller_id : o.buyer_id;
  notify(other, '거래에 문제 제기가 접수되었습니다', `${o.title} — ${REASONS[reasonCode]}`, `/disputes/${id}`);
  notifyStaff('support', '분쟁 접수', `${o.order_no} — ${REASONS[reasonCode]}`, `/admin/disputes/${id}`);
  if (hold === 'failed') notifyStaff('settlement', '외부 지급 보류 실패', o.order_no, `/admin/disputes/${id}`);
  return getDispute(id);
}

function loadFor(user, disputeId) {
  const d = getDispute(disputeId);
  const o = d && orders.getOrder(d.order_id);
  const role = o && orders.roleIn(o, user);
  if (!role) throw new AppError('찾을 수 없습니다.', 404);
  return { dispute: d, order: o, role };
}

function addEntry(user, disputeId, { kind, body, fileId = null }) {
  const { dispute: d } = loadFor(user, disputeId);
  must(['open', 'admin_review', 'appealed'].includes(d.status), '종결된 분쟁입니다.', 409);
  must(['statement', 'evidence'].includes(kind), '잘못된 요청입니다.');
  must(str(body).length >= 2 || fileId, '내용을 입력하세요.');
  return entry(d.id, user, kind, body, { file_id: fileId });
}

function propose(user, disputeId, { type, amount, body }) {
  const { dispute: d, order: o } = loadFor(user, disputeId);
  must(d.status === 'open', '합의 제안을 할 수 없는 상태입니다.', 409);
  must(['refund_full', 'refund_partial', 'resume', 'release'].includes(type), '제안 유형을 선택하세요.');
  if (type === 'refund_partial') must(Number.isInteger(amount) && amount > 0 && amount < o.amount - o.refunded_amount, '부분 환불 금액이 올바르지 않습니다.');
  const id = entry(d.id, user, 'proposal', body, { proposal_type: type, proposal_amount: type === 'refund_partial' ? amount : null });
  notify(user.id === o.buyer_id ? o.seller_id : o.buyer_id, '합의 제안이 도착했습니다', OUTCOMES[type], `/disputes/${d.id}`);
  return id;
}

async function answerProposal(user, disputeId, entryId, accept) {
  const { dispute: d, order: o } = loadFor(user, disputeId);
  must(d.status === 'open', '합의할 수 없는 상태입니다.', 409);
  const p = q.get("SELECT * FROM dispute_entries WHERE id = ? AND dispute_id = ? AND kind = 'proposal'", entryId, d.id);
  must(p, '제안을 찾을 수 없습니다.', 404);
  const proposerSide = orders.roleIn(o, { id: p.user_id }), mySide = orders.roleIn(o, user);
  must(proposerSide !== mySide, '상대방의 제안에만 답할 수 있습니다.', 403);
  must(!q.get("SELECT 1 FROM dispute_entries WHERE dispute_id = ? AND kind IN ('proposal_accept','proposal_decline') AND body = ?", d.id, String(p.id)), '이미 답변한 제안입니다.', 409);
  entry(d.id, user, accept ? 'proposal_accept' : 'proposal_decline', String(p.id));
  if (accept) await applyResolution(d, o, { resolution: p.proposal_type, amount: p.proposal_amount, reason: `양측 합의(제안 #${p.id})`, actor: null, agreement: true });
}

function escalate(user, disputeId) {
  const { dispute: d, order: o } = loadFor(user, disputeId);
  must(d.status === 'open', '이미 운영자 검토 중이거나 종결되었습니다.', 409);
  q.update('disputes', d.id, { status: 'admin_review' });
  notifyStaff('support', '분쟁 운영자 판단 요청', o.order_no, `/admin/disputes/${d.id}`);
}

async function applyResolution(d, o, { resolution, amount, reason, actor, agreement = false, final = false }) {
  const now = clock.iso();
  const appealDays = q.settingInt('appeal_days');
  const deadline = agreement || final ? null : addDays(now, appealDays);
  q.update('disputes', d.id, { status: resolution === 'external' ? 'external' : 'resolved', resolution, resolution_amount: amount ?? null, resolution_reason: reason, resolved_by: actor?.id ?? null, resolved_at: now, appeal_deadline: deadline });
  const cur = orders.getOrder(o.id);
  const patch = { dispute_status: resolution === 'external' ? 'open' : 'resolved' };
  const settlement = require('./settlement');
  let refundResult = null;
  if (resolution === 'refund_full' || resolution === 'refund_partial') {
    q.update('orders', o.id, patch);
    const amt = resolution === 'refund_full' ? cur.amount - cur.refunded_amount : amount;
    refundResult = await require('./refunds').execute(actor, o.id, amt, { disputeId: d.id, reason });
    if (resolution === 'refund_partial' && cur.inspection_status === 'in_progress') {
      q.update('orders', o.id, { inspection_status: 'closed_by_admin', confirmed_at: now, payout_hold_until: deadline });
    }
  } else if (resolution === 'resume') {
    // 거래 재개: 납품이 있었으면 검수 기한을 새로 준다. 없었으면 납품 기한을 새로 준다.
    Object.assign(patch, { refund_status: cur.refund_status === 'requested' ? 'rejected' : cur.refund_status, payout_status: cur.payout_status === 'held' ? 'not_eligible' : cur.payout_status });
    if (cur.delivery_status === 'delivered') Object.assign(patch, { inspection_status: 'in_progress', inspection_started_at: now, inspection_due_at: addDays(now, cur.inspection_days) });
    else patch.delivery_due_at = addDays(now, Math.max(cur.delivery_days, 3));
    q.update('orders', o.id, patch);
  } else if (resolution === 'release') {
    Object.assign(patch, { refund_status: cur.refund_status === 'requested' ? 'rejected' : cur.refund_status, payout_hold_until: deadline });
    if (cur.delivery_status === 'delivered' && ['in_progress', 'not_started'].includes(cur.inspection_status)) Object.assign(patch, { inspection_status: 'closed_by_admin', confirmed_at: now });
    q.update('orders', o.id, patch);
  } else q.update('orders', o.id, patch);
  // 외부 보류 해제(환불로 끝나지 않은 경우)
  if (['resume', 'release'].includes(resolution) && d.external_hold === 'confirmed') {
    const pay = q.get("SELECT * FROM payments WHERE order_id = ? AND status = 'paid'", o.id);
    try { await providers.byName(pay.provider).setPayoutHold({ providerPaymentId: pay.provider_payment_id, hold: false }); q.update('disputes', d.id, { external_hold_detail: d.external_hold_detail + ' → 보류 해제 요청 완료' }); }
    catch (e) { notifyStaff('settlement', '외부 보류 해제 실패', o.order_no, `/admin/disputes/${d.id}`); }
  }
  settlement.refresh(o.id);
  const how = deadline ? `결과에 동의하지 않으면 ${appealDays}일 이내(~${deadline.slice(0, 10)}) 분쟁 화면에서 이의제기를 할 수 있습니다. ` : '';
  for (const uid of [o.buyer_id, o.seller_id]) notify(uid, `분쟁 처리 결과: ${OUTCOMES[resolution]}`, `근거: ${str(reason, 300)} / ${how}${EXTERNAL_GUIDE}`, `/disputes/${d.id}`);
  return refundResult;
}

// 운영자 결정. 근거 없이는 처리할 수 없고 처리자와 일시가 남는다.
async function resolve(admin, disputeId, { resolution, amount, reason }) {
  const d = getDispute(disputeId);
  must(d && ['open', 'admin_review', 'appealed', 'external'].includes(d.status), '처리할 수 있는 분쟁이 아닙니다.', 409);
  must(OUTCOMES[resolution], '처리 결과를 선택하세요.');
  must(str(reason).length >= 10, '판단 근거를 10자 이상 적어 주세요.');
  const o = orders.getOrder(d.order_id);
  if (resolution === 'refund_partial') must(Number.isInteger(amount) && amount > 0 && amount < o.amount - o.refunded_amount, '부분 환불 금액이 올바르지 않습니다.');
  const isAppeal = d.status === 'appealed';
  if (isAppeal) must(admin.staff?.includes('super'), '이의제기 건은 최고관리자가 처리합니다.', 403);
  entry(d.id, admin, 'admin_note', `[결정] ${OUTCOMES[resolution]}${amount ? ` ${amount.toLocaleString('ko-KR')}원` : ''} — ${str(reason)}`);
  audit(admin, isAppeal ? 'dispute.resolve_appeal' : 'dispute.resolve', 'dispute', d.id, { resolution, amount, reason: str(reason) });
  return applyResolution(d, o, { resolution, amount, reason: str(reason), actor: admin, final: isAppeal });
}

function appeal(user, disputeId, text) {
  const { dispute: d, order: o } = loadFor(user, disputeId);
  must(d.status === 'resolved' && d.appeal_deadline && d.appeal_deadline > clock.iso() && !d.appeal_at, '이의제기 기간이 아니거나 이미 이의제기를 했습니다.', 409);
  must(str(text).length >= 10, '이의제기 사유를 10자 이상 적어 주세요.');
  q.update('disputes', d.id, { status: 'appealed', appeal_by: user.id, appeal_text: str(text), appeal_at: clock.iso() });
  const cur = orders.getOrder(o.id);
  q.update('orders', o.id, { dispute_status: 'open', payout_status: ['eligible', 'not_eligible', 'failed'].includes(cur.payout_status) ? 'held' : cur.payout_status });
  audit(user, 'dispute.appeal', 'dispute', d.id);
  notifyStaff('super', '분쟁 이의제기 접수', o.order_no, `/admin/disputes/${d.id}`);
}

// 같은 상품·판매자의 다른 분쟁·주문(유사 피해 확인용)
function similar(order) {
  return q.all(`SELECT o.id, o.order_no, o.title, o.dispute_status, o.payment_status, o.created_at, d.reason_code
    FROM orders o LEFT JOIN disputes d ON d.order_id = o.id
    WHERE o.id <> ? AND o.payment_status <> 'none' AND (o.seller_id = ? AND (o.product_id IS ? OR d.id IS NOT NULL)) ORDER BY o.id DESC LIMIT 30`, order.id, order.seller_id, order.product_id);
}
module.exports = { REASONS, OUTCOMES, EXTERNAL_GUIDE, getDispute, open, loadFor, addEntry, propose, answerProposal, escalate, resolve, appeal, similar };
