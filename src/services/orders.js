'use strict';
const { q } = require('../db');
const { clock, addDays, sha256, stableStringify, randomId, must, AppError, notFound } = require('../util');
const providers = require('../providers');
const storage = require('../storage');
const scanner = require('../scanner');
const fees = require('./fees');
const ledger = require('./ledger');
const { audit, notify, notifyStaff } = require('../log');

const getOrder = (id) => q.get('SELECT * FROM orders WHERE id = ?', id);
const snapshotOf = (o) => JSON.parse(o.snapshot_json);

// 결제 사업자의 보류·자동확정 일정과 플랫폼의 납품·검수 일정이 맞는지 확인한다.
// 맞지 않으면 결제를 막는다(보호 기간을 확보할 수 없는 상품).
function scheduleCheck(deliveryDays, inspectionDays) {
  const c = providers.caps();
  const buffer = q.settingInt('dispute_buffer_days');
  const needed = deliveryDays + inspectionDays + buffer;
  const problems = [];
  if (!c.checkout_enabled) problems.push('결제 사업자의 필수 확인 항목이 완료되지 않아 결제를 받을 수 없습니다.');
  if (c.escrow_hold && c.max_hold_days != null && needed > c.max_hold_days)
    problems.push(`납품 기한(${deliveryDays}일)+검수 기간(${inspectionDays}일)+분쟁 여유(${buffer}일)=${needed}일이 결제 사업자의 최대 보류 기간(${c.max_hold_days}일)을 넘습니다.`);
  if (c.auto_confirm_days && needed > c.auto_confirm_days)
    problems.push(`결제 사업자가 ${c.auto_confirm_days}일 뒤 자동확정하므로 검수 종료(${needed}일)보다 먼저 지급될 수 있습니다.`);
  return { ok: problems.length === 0, problems, needed, caps: c };
}

function protectionNotice(c) {
  if (c.mode === 'test') return '테스트 결제입니다. 실제 돈이 이동하지 않으며 결제대금 보호도 적용되지 않습니다.';
  if (c.escrow_hold) return `결제 사업자(${c.provider})가 최대 ${c.max_hold_days ?? '?'}일간 대금을 보류합니다. 실제 보류 여부는 결제 후 주문 화면에 표시됩니다.`;
  return '이 결제에는 결제 사업자의 대금 보호가 적용되지 않습니다. 플랫폼은 검수 확인 전까지 판매자 정산 요청만 보류합니다.';
}

function createOrder({ kind, buyer, sellerId, title, amount, terms, inspectionDays, deliveryDays = 0, categoryId = null, refs = {}, extraVerification = false, companyId = null }) {
  must(buyer.id !== sellerId, '본인의 상품은 구매할 수 없습니다.');
  const seller = q.get('SELECT u.status, s.status AS seller_status FROM users u JOIN seller_profiles s ON s.user_id = u.id WHERE u.id = ?', sellerId);
  must(seller && seller.status === 'active' && seller.seller_status === 'approved', '현재 이 판매자와는 새 거래를 시작할 수 없습니다.');
  const sched = scheduleCheck(deliveryDays, inspectionDays);
  if (!sched.ok) throw new AppError(sched.problems.join(' '), 409, 'SCHEDULE_CONFLICT');
  const fee = fees.quote(amount, sellerId, categoryId);
  const snapshot = {
    kind, title, amount, terms, inspection_days: inspectionDays, delivery_days: deliveryDays,
    fee: { bps: fee.fee_bps, amount: fee.fee_amount, vat: fee.fee_vat, policy: fee.fee_policy_label, pg_fee_bps: fee.pg_fee_bps, pg_fee_bearer: fee.pg_fee_bearer },
    protection: { provider: sched.caps.provider, mode: sched.caps.mode, notice: protectionNotice(sched.caps), max_hold_days: sched.caps.max_hold_days },
    agreed_at: clock.iso(),
  };
  const json = stableStringify(snapshot);
  const threshold = q.settingInt('high_value_threshold');
  const id = q.insert('orders', {
    order_no: 'EUM' + clock.iso().slice(2, 10).replace(/-/g, '') + randomId(4).toUpperCase(),
    kind, buyer_id: buyer.id, seller_id: sellerId, company_id: companyId,
    product_id: refs.productId ?? null, option_id: refs.optionId ?? null, version_id: refs.versionId ?? null,
    milestone_id: refs.milestoneId ?? null, ip_deal_id: refs.ipDealId ?? null,
    title, amount, snapshot_json: json, terms_hash: sha256(json),
    fee_bps: fee.fee_bps, fee_amount: fee.fee_amount, fee_vat: fee.fee_vat,
    pg_fee_bps: fee.pg_fee_bps, pg_fee_amount: fee.pg_fee_amount, pg_fee_bearer: fee.pg_fee_bearer,
    inspection_days: inspectionDays, delivery_days: deliveryDays,
    extra_verification: extraVerification || (kind === 'ip' && amount >= threshold) ? 1 : 0,
    created_at: clock.iso(),
  });
  audit(buyer, 'order.create', 'order', id, { terms_hash: sha256(json) });
  return getOrder(id);
}

function versionFiles(versionId) {
  return q.all(`SELECT f.id, f.original_name, f.size, f.sha256, f.scan_malware, f.scan_secrets, f.scan_archive, f.scan_override_by, vf.role
    FROM product_version_files vf JOIN files f ON f.id = vf.file_id WHERE vf.version_id = ? ORDER BY vf.role, f.id`, versionId);
}

function createProductOrder(buyer, { productId, optionId, agreed, extraVerification, companyId }) {
  const p = q.get('SELECT * FROM products WHERE id = ?', productId);
  must(p && p.status === 'approved', '판매 중인 상품이 아닙니다.', 404);
  must(!p.sales_blocked, '운영 정책에 따라 신규 판매가 제한된 상품입니다.', 409);
  const opt = q.get('SELECT * FROM product_options WHERE id = ? AND product_id = ? AND active = 1', optionId, productId);
  must(opt, '판매 옵션을 선택하세요.');
  const ver = q.get("SELECT * FROM product_versions WHERE id = ? AND status = 'approved'", p.current_version_id);
  must(ver, '승인된 납품 파일이 없어 구매할 수 없습니다.', 409);
  must(agreed, '제공물·라이선스·검수 조건에 동의해야 주문할 수 있습니다.');
  if (companyId) {
    const m = q.get('SELECT * FROM company_members WHERE company_id = ? AND user_id = ?', companyId, buyer.id);
    must(m && m.role !== 'inspector', '이 기업 계정으로 구매할 권한이 없습니다.', 403);
    const co = q.get('SELECT * FROM companies WHERE id = ?', companyId);
    if (co.require_approval && m.role !== 'admin') {
      const ap = q.get("SELECT * FROM purchase_approvals WHERE company_id = ? AND requester_id = ? AND product_id = ? AND option_id = ? AND status = 'approved'", companyId, buyer.id, productId, optionId);
      must(ap, '기업 관리자의 구매 승인이 필요합니다.', 403, 'APPROVAL_REQUIRED');
      q.update('purchase_approvals', ap.id, { status: 'used' });
    }
  }
  const files = versionFiles(ver.id).filter((f) => f.role !== 'source' || opt.includes_source || p.type === 'source');
  const cat = p.category_id ? q.get('SELECT name FROM categories WHERE id = ?', p.category_id)?.name : null;
  const terms = {
    deal_type: p.type === 'source' || opt.includes_source ? 'source_delivery' : 'license',
    deal_type_label: p.type === 'source' || opt.includes_source ? '소스코드 인도 + 이용허락(권리 양도 아님)' : '프로그램 사용권(권리 양도 아님)',
    product: {
      id: p.id, title: p.title, category: cat, summary: p.summary, problem: p.problem, description: p.description, features: p.features,
      included: p.included, excluded: p.excluded, platform: p.platform, environments: p.environments, install_method: p.install_method,
      install_support: !!p.install_support, install_done_criteria: p.install_done_criteria, external_paid_required: !!p.external_paid_required,
      external_costs: p.external_costs, third_party_licenses: p.third_party_licenses, update_support: p.update_support,
    },
    option: { id: opt.id, name: opt.name, price: opt.price, term: opt.term, term_days: opt.term_days, seats: opt.seats, devices: opt.devices, includes_source: !!opt.includes_source, includes_install: !!opt.includes_install },
    license: { modify: !!p.lic_modify, commercial: !!p.lic_commercial, redistribute: !!p.lic_redistribute, resale: !!p.lic_resale, notes: p.license_notes, ip_transfer: false },
    version: { id: ver.id, label: ver.label, manifest_hash: ver.manifest_hash, files: files.map((f) => ({ id: f.id, name: f.original_name, size: f.size, sha256: f.sha256, role: f.role })) },
    inspection_criteria: p.inspection_criteria, refund_policy: p.refund_policy,
  };
  return createOrder({
    kind: 'product', buyer, sellerId: p.seller_id, title: `${p.title} — ${opt.name}`, amount: opt.price, terms,
    inspectionDays: p.inspection_days, deliveryDays: 0, categoryId: p.category_id,
    refs: { productId: p.id, optionId: opt.id, versionId: ver.id },
    extraVerification: !!extraVerification && opt.price >= q.settingInt('high_value_threshold'), companyId: companyId || null,
  });
}

async function startPayment(order, user) {
  must(order.buyer_id === user.id, '주문자만 결제할 수 있습니다.', 403);
  must(['none', 'failed', 'cancelled'].includes(order.payment_status), '이미 결제가 진행된 주문입니다.', 409);
  const sched = scheduleCheck(order.delivery_days, order.inspection_days);
  if (!sched.ok) throw new AppError(sched.problems.join(' '), 409, 'SCHEDULE_CONFLICT');
  const p = providers.active();
  q.run("UPDATE payments SET status = 'failed' WHERE order_id = ? AND status = 'pending'", order.id);
  const r = await p.createPayment({ orderNo: order.order_no, amount: order.amount, title: order.title });
  q.insert('payments', { order_id: order.id, provider: p.name, mode: p.mode, provider_payment_id: r.providerPaymentId, amount: order.amount, status: 'pending', created_at: clock.iso() });
  q.update('orders', order.id, { payment_status: 'pending' });
  return r;
}

// 결제 상태 반영의 유일한 경로. 웹훅 본문이나 브라우저 화면을 믿지 않고 사업자에 조회한 값으로만 갱신한다.
async function syncPayment(paymentRowId) {
  const pay = q.get('SELECT * FROM payments WHERE id = ?', paymentRowId);
  if (!pay || !pay.provider_payment_id) return null;
  const provider = providers.byName(pay.provider);
  const ext = await provider.getPayment(pay.provider_payment_id);
  let granted = false;
  q.txi(() => {
    const cur = q.get('SELECT * FROM payments WHERE id = ?', pay.id);
    const order = getOrder(cur.order_id);
    q.update('payments', cur.id, { provider_status: ext.rawStatus, provider_refunded: ext.refunded, provider_fee: ext.fee, method: ext.method || cur.method, last_synced_at: clock.iso() });
    const wasPaid = ['paid', 'partially_refunded', 'refunded'].includes(ext.status);
    if (wasPaid && cur.status === 'pending') {
      if (ext.amount !== order.amount) {
        // 금액이 다르면 권한을 발급하지 않고 대사 문제로 남긴다.
        q.run(`INSERT OR IGNORE INTO reconciliation_issues (kind, order_id, ref, internal_value, external_value, first_seen_at, last_seen_at) VALUES ('amount_mismatch', ?, ?, ?, ?, ?, ?)`,
          order.id, cur.provider_payment_id, String(order.amount), String(ext.amount), clock.iso(), clock.iso());
        notifyStaff('settlement', '결제 금액 불일치', order.order_no, `/admin/orders/${order.id}`);
        return;
      }
      const now = clock.iso();
      q.update('payments', cur.id, { status: 'paid', paid_at: ext.paidAt || now });
      const prot = provider.mode === 'test' ? 'simulated' : ext.escrow.state === 'HELD' ? 'held' : ext.escrow.state === 'NONE' ? 'unsupported' : 'unknown';
      q.update('orders', order.id, { payment_status: 'paid', paid_at: now, protection_status: prot });
      q.insert('protection_records', { order_id: order.id, provider: provider.name, state: ext.escrow.state, hold_until: ext.escrow.holdUntil, auto_confirm_at: ext.escrow.autoConfirmAt, detail: provider.mode === 'test' ? '테스트 사업자(시뮬레이션)' : '', created_at: now });
      const sellerPass = order.pg_fee_bearer === 'seller' ? order.pg_fee_amount : 0;
      ledger.post(order.id, 'payment', [
        ['pg_holding', order.amount], ['seller_payable', -(order.amount - order.fee_amount - sellerPass)],
        ['platform_fee', -order.fee_amount], ['pg_cost_passthrough', -sellerPass],
      ], cur.provider_payment_id);
      granted = true;
    } else if (['failed'].includes(ext.status) && cur.status === 'pending') {
      q.update('payments', cur.id, { status: 'failed' });
      if (order.payment_status === 'pending') q.update('orders', order.id, { payment_status: 'failed' });
    }
  });
  if (granted) grantAccess(pay.order_id);
  return ext;
}

function startInspection(orderId) {
  const o = getOrder(orderId);
  if (o.delivery_status !== 'delivered' || o.inspection_status === 'in_progress') return;
  const now = clock.iso();
  q.update('orders', orderId, { inspection_status: 'in_progress', inspection_started_at: now, inspection_due_at: addDays(now, o.inspection_days), close_review_requested_at: null });
  q.insert('inspection_events', { order_id: orderId, action: 'started', detail: `검수 기한 ${o.inspection_days}일`, created_at: now });
  notify(o.buyer_id, '검수 기간이 시작되었습니다', `${o.title} — ${o.inspection_days}일 이내에 확인해 주세요.`, `/my/orders/${o.id}`);
}

// 결제 확인 뒤 접근 권한 발급. 파일을 실제로 읽을 수 있을 때만 납품 완료 → 검수 시작.
function grantAccess(orderId) {
  const o = getOrder(orderId);
  if (!['paid', 'partially_refunded'].includes(o.payment_status)) return false;
  const now = clock.iso();
  q.run('INSERT OR IGNORE INTO entitlements (order_id, user_id, granted_at) VALUES (?, ?, ?)', o.id, o.buyer_id, now);
  if (o.kind === 'product') {
    const snap = snapshotOf(o);
    const rows = snap.terms.version.files.map((f) => q.get('SELECT * FROM files WHERE id = ?', f.id));
    const ok = rows.length > 0 && rows.every((f, i) => f && f.sha256 === snap.terms.version.files[i].sha256 && storage.isReadable(f));
    if (!ok) {
      q.update('orders', o.id, { delivery_status: 'access_failed' });
      notifyStaff('support', '납품물 접근 실패', `${o.order_no}: 결제는 확인됐지만 납품 파일을 읽을 수 없습니다. 검수 기간은 시작되지 않았습니다.`, `/admin/orders/${o.id}`, `access_failed:${o.id}`);
      notify(o.buyer_id, '납품물 준비가 지연되고 있습니다', '결제는 확인되었습니다. 파일 접근 문제를 복구 중이며, 복구된 시점부터 검수 기간이 시작됩니다.', `/my/orders/${o.id}`, `access_failed:${o.id}`);
      return false;
    }
    q.update('orders', o.id, { delivery_status: 'delivered', delivered_at: now });
    startInspection(o.id);
    notify(o.seller_id, '새 주문이 결제되었습니다', o.title, `/my/sales/${o.id}`);
  } else {
    q.update('orders', o.id, { delivery_status: 'awaiting_seller', delivery_due_at: addDays(now, o.delivery_days) });
    if (o.kind === 'milestone') q.run("UPDATE milestones SET status = 'in_progress' WHERE id = ?", o.milestone_id);
    if (o.kind === 'ip') q.run("UPDATE ip_deals SET status = 'transfer' WHERE id = ? AND status IN ('terms_agreed','paid')", o.ip_deal_id);
    notify(o.seller_id, '결제가 확인되었습니다 — 작업을 시작하세요', o.title, `/my/sales/${o.id}`);
  }
  return true;
}

// 파일 접근 실패 주문 복구(주기 작업·운영자 수동 실행)
function retryAccess() {
  let fixed = 0;
  for (const o of q.all("SELECT id FROM orders WHERE delivery_status = 'access_failed'")) if (grantAccess(o.id)) fixed++;
  return fixed;
}

// 주문에 연결된 납품 파일 목록
function orderFiles(o) {
  if (o.kind === 'product') {
    const snap = snapshotOf(o);
    return snap.terms.version.files.map((sf) => {
      const f = q.get('SELECT * FROM files WHERE id = ?', sf.id);
      return { ...sf, scan: f ? scanner.overall(f) : 'pending', scan_detail: f, hash_ok: !!f && f.sha256 === sf.sha256, source: `버전 ${snap.terms.version.label}` };
    });
  }
  return q.all(`SELECT f.*, df.role, d.seq FROM deliveries d JOIN delivery_files df ON df.delivery_id = d.id JOIN files f ON f.id = df.file_id
    WHERE d.order_id = ? AND d.status = 'submitted' ORDER BY d.seq, f.id`, o.id)
    .map((f) => ({ id: f.id, name: f.original_name, size: f.size, sha256: f.sha256, role: f.role, scan: scanner.overall(f), scan_detail: f, hash_ok: true, source: `${f.seq}차 납품` }));
}

// 이 주문을 볼 수 있는 사람인가(구매자, 판매자, 구매 기업의 관리자·검수 담당자)
function roleIn(o, user) {
  if (!user) return null;
  if (o.buyer_id === user.id) return 'buyer';
  if (o.seller_id === user.id) return 'seller';
  if (o.company_id) {
    const m = q.get('SELECT role FROM company_members WHERE company_id = ? AND user_id = ?', o.company_id, user.id);
    if (m && (m.role === 'admin' || m.role === 'inspector')) return 'buyer';
  }
  return null;
}
function loadFor(user, orderId) {
  const o = getOrder(orderId);
  if (!o) throw notFound('주문을 찾을 수 없습니다.');
  const role = roleIn(o, user);
  if (!role) throw notFound('주문을 찾을 수 없습니다.');   // 타인 주문은 존재 여부도 알리지 않는다.
  return { order: o, role };
}

module.exports = { getOrder, snapshotOf, scheduleCheck, protectionNotice, createOrder, createProductOrder, startPayment, syncPayment, startInspection, grantAccess, retryAccess, orderFiles, versionFiles, roleIn, loadFor };
