'use strict';
// 주문 화면 공통 조각(구매자·판매자·운영자 화면에서 함께 쓴다)
const { q } = require('../db');
const ui = require('../ui');
const { html, badge, tag, hashChip, won, fmtDate, dl, card, nl2br, bullets, notice, size, bpsPct } = ui;
const orders = require('../services/orders');
const ledger = require('../services/ledger');
const settlement = require('../services/settlement');
const { ROLES } = require('../services/deliveries');
const { LIMIT_NOTICE } = require('../services/refunds');

const KIND = { product: '완성형 상품', milestone: '맞춤 개발 단계', ip: '지식재산권 거래' };
const LIC = (l) => [['수정', l.modify], ['상업적 이용', l.commercial], ['재배포', l.redistribute], ['재판매', l.resale]];

// 돈과 납품물의 현재 상태(주문에 저장된 상태 값 그대로)
function ledgerPanel(o, role) {
  const pr = q.get('SELECT * FROM protection_records WHERE order_id = ? ORDER BY id DESC', o.id);
  const paid = ['paid', 'partially_refunded', 'refunded'].includes(o.payment_status);
  const payable = paid ? ledger.sellerPayable(o.id) : null;
  const row = (k, v) => html`<div class="ledger-row"><span class="sub">${k}</span><span>${v}</span></div>`;
  const foot = {
    simulated: '테스트 결제입니다. 실제 돈이 이동하지 않았고 결제대금 보호도 없습니다',
    held: `결제 사업자가 대금을 보류 중이라고 응답했습니다${pr?.hold_until ? ` (보류 한도 ${fmtDate(pr.hold_until, false)})` : ''}`,
    unsupported: '이 결제에는 결제 사업자의 대금 보호가 적용되지 않습니다. 플랫폼은 검수 확인 전까지 판매자 지급 요청만 보류합니다',
    unknown: '결제 사업자의 보호 상태를 확인하는 중입니다. 확인 전에는 보호된다고 보지 마세요',
    released: '보류가 해제되어 판매자에게 지급되었습니다', none: '결제 전입니다',
  }[o.protection_status];
  return html`<div class="ledger">
    <div class="ledger-head"><span>${o.order_no} · ${KIND[o.kind]}</span><span>조건 지문 ${hashChip(o.terms_hash)}</span></div>
    <div class="ledger-cols">
      <div class="ledger-col"><h3>돈의 상태</h3>
        <div class="amount">${won(o.amount)}</div>
        ${row('결제', badge('payment', o.payment_status))}
        ${row('대금 보호', badge('protection', o.protection_status))}
        ${row('환불', html`${badge('refund', o.refund_status)}${o.refunded_amount ? html` <span class="muted">${won(o.refunded_amount)}</span>` : ''}`)}
        ${row('판매자 지급', badge('payout', o.payout_status))}
        ${role !== 'buyer' && payable != null ? row('지급 대기 금액', won(payable)) : ''}
      </div>
      <div class="ledger-col"><h3>납품물의 상태</h3>
        ${row('납품', badge('delivery', o.delivery_status))}
        ${o.delivery_due_at && o.delivery_status !== 'delivered' ? row('납품 기한', fmtDate(o.delivery_due_at)) : ''}
        ${row('검수', badge('inspection', o.inspection_status))}
        ${o.inspection_due_at && o.inspection_status === 'in_progress' ? row('검수 기한', fmtDate(o.inspection_due_at)) : ''}
        ${row('분쟁', badge('dispute', o.dispute_status))}
        ${o.confirmed_at ? row('확정 일시', fmtDate(o.confirmed_at)) : ''}
      </div>
    </div>
    <div class="ledger-foot">${foot}</div>
  </div>`;
}

// 정산을 막고 있는 사유(판매자·운영자용)
function blockersCard(o) {
  if (!['paid', 'partially_refunded'].includes(o.payment_status) || ['paid', 'requested', 'unknown'].includes(o.payout_status)) return '';
  const b = settlement.blockers(o);
  return card('정산 조건 확인', b.length ? html`<p class="sub">아래 조건이 모두 해소되면 지급 요청이 가능합니다</p><ul class="list">${b.map((x) => html`<li>${x}</li>`)}</ul>` : html`<p>모든 조건을 충족했습니다. 정산 주기에 맞춰 지급 요청됩니다</p>`);
}

// 주문 시점에 고정된 조건
function termsCard(o) {
  const s = orders.snapshotOf(o), t = s.terms;
  let body;
  if (o.kind === 'product') {
    body = html`${dl([
      ['거래 유형', html`${t.deal_type_label}`],
      ['옵션', html`${t.option.name} · ${t.option.term === 'term' ? `기간제 ${t.option.term_days}일` : '영구'}${t.option.seats ? ` · 사용자 ${t.option.seats}명` : ''}${t.option.devices ? ` · 기기 ${t.option.devices}대` : ''}`],
      ['받는 권리', html`${LIC(t.license).map(([k, v]) => tag(`${k} ${v ? '허용' : '불가'}`, v ? 'ok' : ''))} ${tag('지식재산권 양도 없음')}${t.license.notes ? html`<p class="hint">${nl2br(t.license.notes)}</p>` : ''}`],
      ['포함 범위', bullets(t.product.included)], ['제외 범위', bullets(t.product.excluded)],
      ['지원 환경', nl2br(t.product.environments)],
      ['추가 비용', t.product.external_paid_required ? html`${tag('외부 유료 서비스 필요', 'warn')} ${nl2br(t.product.external_costs)}` : '고지된 외부 유료 서비스 없음'],
      ['설치 지원', t.option.includes_install ? html`포함 — 완료 조건: ${t.product.install_done_criteria || '판매자와 협의'}` : '미포함'],
      ['검수 기준', nl2br(t.inspection_criteria)], ['검수 기간', `납품물 접근 가능 시점부터 ${s.inspection_days}일`],
      ['환불·분쟁', nl2br(t.refund_policy)],
      ['납품 버전', html`${t.version.label} ${hashChip(t.version.manifest_hash)}`],
    ])}`;
  } else if (o.kind === 'milestone') {
    body = dl([['거래 유형', '맞춤 개발 단계 결제(단계별 별도 주문)'], ['계약', html`<a href="/my/contracts/${t.contract_id}">${t.contract_title}</a> · 계약 버전 ${t.contract_version} ${hashChip(t.contract_hash)}`],
      ['단계', `${t.seq}단계 — ${t.title}`], ['산출물', bullets(t.deliverables)], ['검수 기준', nl2br(t.criteria)],
      ['소스 인도', t.requires_source ? '이 단계에 소스코드·실행 방법 포함 필수' : '이 단계 필수 아님'], ['납품 기한', `결제 확인 후 ${s.delivery_days}일`], ['검수 기간', `납품 후 ${s.inspection_days}일`]]);
  } else {
    body = dl([['거래 유형', t.deal_type_label], ['대상', t.subject], ['범위', nl2br(t.scope)], ['기간·지역·분야', `${t.term || '-'} / ${t.territory || '-'} / ${t.field_of_use || '-'}`],
      ['포함 자산', bullets(t.included_assets)], ['제외 자산', bullets(t.excluded_assets)], ['기존 이용허락·제약', nl2br(t.existing_licenses)],
      ['계약서', html`${tag('법률 검토 전 초안', 'warn')} 조건 지문 ${hashChip(t.terms_hash)}`]]);
  }
  return card('주문 시점에 고정된 조건', html`${body}<p class="hint">이 조건은 ${fmtDate(s.agreed_at)}에 고정되었습니다. 판매자가 상품을 수정해도 이 주문에는 영향을 주지 않습니다</p>`);
}

const scanCells = (f) => html`${badge('scan', f.scan_malware, `악성 ${ui.label('scan', f.scan_malware)}`)} ${badge('scan', f.scan_secrets, `비밀값 ${ui.label('scan', f.scan_secrets)}`)} ${badge('scan', f.scan_archive, `압축 ${ui.label('scan', f.scan_archive)}`)}`;

function filesCard(req, o, role, linkBase) {
  const files = orders.orderFiles(o);
  const canDl = role !== 'buyer' || (['paid', 'partially_refunded'].includes(o.payment_status) && o.delivery_status === 'delivered');
  const rows = files.map((f) => [
    html`${f.name}<br><span class="muted">${ROLES[f.role] || f.role} · ${f.source} · ${size(f.size)}</span>`,
    html`${hashChip(f.sha256, 16)}${f.hash_ok ? '' : tag('해시 불일치', 'bad')}`,
    f.scan_detail ? scanCells(f.scan_detail) : '',
    canDl ? ui.postBtn(req, `${linkBase}/files/${f.id}/link`, '다운로드', { cls: 'sm' }) : html`<span class="muted">-</span>`,
  ]);
  const downloads = q.get("SELECT COUNT(*) c, MAX(created_at) last FROM download_logs WHERE order_id = ? AND result = 'ok' AND context = 'order'", o.id);
  return card('납품 파일', html`
    ${o.payment_status === 'refunded' ? notice(LIMIT_NOTICE, 'warn') : ''}
    ${o.delivery_status === 'access_failed' ? notice('결제는 확인되었지만 파일 접근에 문제가 있어 복구 중입니다. 복구된 시점부터 검수 기간이 시작됩니다', 'bad') : ''}
    ${ui.table(['파일', 'SHA-256', '검사 결과(항목별)', ''], rows, o.kind === 'product' ? '결제 확인 후 표시됩니다' : '아직 납품된 파일이 없습니다')}
    <p class="hint">다운로드 링크는 발급 후 ${q.settingInt('download_link_minutes')}분간 1회만 유효하고 모든 접근이 기록됩니다. 해시는 같은 파일인지 확인하는 용도이며 기능 작동이나 판매 권한을 증명하지 않습니다. 검사 결과는 항목별로 독립이며 '검사 불가'는 검사하지 못했다는 뜻입니다</p>
    ${role !== 'buyer' ? html`<p class="hint">구매자 다운로드 기록: ${downloads.c}회${downloads.last ? ` · 최근 ${fmtDate(downloads.last)}` : ''}</p>` : ''}`);
}

function moneyCard(o, role) {
  if (role === 'buyer') return '';
  const sellerPg = o.pg_fee_bearer === 'seller' ? o.pg_fee_amount : 0;
  const po = q.get("SELECT * FROM payouts WHERE order_id = ? AND status IN ('created','requested','unknown','paid') ORDER BY id DESC", o.id);
  const payable = po ? po.gross_amount ?? po.amount : ledger.sellerPayable(o.id);
  const est = require('../services/tax').withholding(o.seller_id, payable);
  const taxLine = (x) => (x.tax_type === 'individual' ? `사업소득 원천징수 — 소득세 ${won(x.withholding_income)} + 지방소득세 ${won(x.withholding_local)} 공제`
    : x.tax_type === 'general' ? `수수료 세금계산서 대상 — 공급가액 ${won(o.fee_amount - o.fee_vat)} + 부가세 ${won(o.fee_vat)}` : '간이과세자 — 세금계산서 수수 여부에 따라 정산 내역 기록');
  return card('정산 내역', dl([
    ['결제액', won(o.amount)], ['플랫폼 수수료', html`${won(o.fee_amount)} <span class="muted">(${bpsPct(o.fee_bps)}, 부가세 ${won(o.fee_vat)} 포함 — 주문 시점 정책 고정)</span>`],
    ['결제 비용', html`${won(o.pg_fee_amount)} <span class="muted">(추정 ${bpsPct(o.pg_fee_bps)}, ${o.pg_fee_bearer === 'seller' ? '판매자 부담' : '플랫폼 부담'})</span>`],
    ['환불액', won(o.refunded_amount)], ['정산 대상액', html`${won(payable)} <span class="muted">(주문 시 예상 ${won(o.amount - o.fee_amount - sellerPg)})</span>`],
    ['세무 처리', po && po.tax_type ? taxLine(po) : html`${taxLine({ tax_type: est.taxType, withholding_income: est.income, withholding_local: est.local })} <span class="muted">(현재 과세 유형 기준 예상)</span>`],
    ['실제 지급액', html`${won(q.get("SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE order_id = ? AND status = 'paid'", o.id).s)}${po && po.status !== 'paid' ? html` <span class="muted">(${won(po.amount)} 지급 진행 중)</span>` : ''}`],
  ]));
}

function timeline(o) {
  const ev = [
    ...q.all('SELECT created_at, action, detail FROM inspection_events WHERE order_id = ?', o.id).map((e) => ({ at: e.created_at, text: ({ started: '검수 기간 시작', approved: '구매확정', revision_requested: '수정 요청', revision_accepted: '수정 요청 수락(계약 범위 내)', revision_quoted: '계약 범위 밖 요청으로 분류', close_review_requested: '판매자의 검수 종료 심사 요청', closed_by_admin: '운영자 검수 종료', auto_approved: '기한 경과 자동확정' }[e.action] || e.action) })),
    o.paid_at && { at: o.paid_at, text: '결제 확인(서버가 결제 사업자에 조회)' }, { at: o.created_at, text: '주문 생성 · 조건 고정' },
    ...q.all("SELECT submitted_at, seq FROM deliveries WHERE order_id = ? AND status = 'submitted'", o.id).map((d) => ({ at: d.submitted_at, text: `${d.seq}차 납품 제출` })),
    ...q.all('SELECT created_at, status, amount, completed_at FROM refunds WHERE order_id = ?', o.id).flatMap((r) => [{ at: r.created_at, text: `환불 처리 시작 ${won(r.amount)}` }, r.completed_at && { at: r.completed_at, text: '환불 완료(결제 취소 성공 확인)' }]),
    ...q.all('SELECT created_at, paid_at, amount FROM payouts WHERE order_id = ?', o.id).flatMap((p) => [{ at: p.created_at, text: `판매자 지급 요청 ${won(p.amount)}` }, p.paid_at && { at: p.paid_at, text: '판매자 지급 완료 확인' }]),
    ...q.all('SELECT created_at, resolved_at FROM disputes WHERE order_id = ?', o.id).flatMap((d) => [{ at: d.created_at, text: '문제 제기 접수' }, d.resolved_at && { at: d.resolved_at, text: '분쟁 처리 결과 확정' }]),
  ].filter(Boolean).sort((a, b) => (a.at < b.at ? -1 : 1));
  return card('거래 기록', ui.table(['일시', '내용'], ev.map((e) => [fmtDate(e.at), e.text])));
}
module.exports = { KIND, LIC, ledgerPanel, blockersCard, termsCard, filesCard, moneyCard, timeline, scanCells };
