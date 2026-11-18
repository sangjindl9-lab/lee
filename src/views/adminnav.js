'use strict';
// 운영자 메뉴. [경로, 이름, 볼 수 있는 권한들] — super는 전부 볼 수 있다.
const ITEMS = [
  ['/admin', '현황', ['review', 'support', 'settlement']],
  ['/admin/sellers', '판매자 심사', ['review']],
  ['/admin/products', '상품·파일 심사', ['review']],
  ['/admin/ip', '권리 매물 심사', ['review']],
  ['/admin/orders', '거래 상태', ['support', 'settlement']],
  ['/admin/disputes', '분쟁', ['support']],
  ['/admin/reports', '신고·권리 침해', ['support', 'review']],
  ['/admin/tickets', '지원 티켓', ['support']],
  ['/admin/payouts', '정산·지급', ['settlement']],
  ['/admin/refunds', '환불', ['settlement']],
  ['/admin/tax', '세무 증빙', ['settlement']],
  ['/admin/reconcile', '대사', ['settlement']],
  ['/admin/fees', '수수료 정책', ['settlement']],
  ['/admin/pg', '결제 사업자 확인표', []],
  ['/admin/settings', '운영 설정', []],
  ['/admin/staff', '운영자 권한', []],
  ['/admin/audit', '감사 기록', []],
];
const forUser = (u) => ITEMS.filter(([, , roles]) => u.staff.includes('super') || roles.some((r) => u.staff.includes(r))).map(([h, l]) => [h, l]);
module.exports = { ITEMS, forUser };
