'use strict';
// 시연용 가공 데이터: 상품 50개와 각 상품의 "거래 완료(구매확정·정산 완료)" 테스트 주문.
// 실제 판매 실적이 아니다. 운영 환경에서는 실행되지 않으며, 테스트 결제 사업자로만 만든다.
// 실서비스를 열기 전에는 data 폴더를 지워 이 데이터를 모두 없애야 한다(가짜 거래량 표시 금지).
if (process.env.NODE_ENV === 'production') { console.error('운영 환경에서는 실행할 수 없습니다.'); process.exit(1); }
const db = require('../src/db'); db.init();
const { q } = db;
const { clock } = require('../src/util');
const providers = require('../src/providers');
const accounts = require('../src/services/accounts');
const catalog = require('../src/services/catalog');
const orders = require('../src/services/orders');
const inspection = require('../src/services/inspection');
const settlement = require('../src/services/settlement');
const storage = require('../src/storage');
const sandbox = require('../src/providers/sandbox');
const webhooks = require('../src/services/webhooks');
if (providers.active().name !== 'sandbox') { console.error('테스트 결제 사업자(sandbox)에서만 실행할 수 있습니다.'); process.exit(1); }
sandbox.state.deliver = (raw, headers) => webhooks.handle('sandbox', raw, headers);

const PW = 'eum-demo-1234';
const SELLERS = [
  ['한빛소프트웍스 데모', 'sole', 'general', '건설·전기 현장 문서 자동화 도구를 만듭니다', 'Node.js, 엑셀 자동화, PDF'],
  ['모아ERP랩', 'corp', 'general', '중소기업용 ERP·그룹웨어를 개발합니다', 'Java, Spring, PostgreSQL, ERP'],
  ['숫자공방', 'sole', 'simplified', '회계·재고·발주 업무 도구를 만듭니다', 'Python, Django, 회계'],
  ['페이퍼리스', 'corp', 'general', '문서·PDF·엑셀 자동화 전문', 'Python, VBA, PDF, OCR'],
  ['샵메이커', 'corp', 'general', '쇼핑몰·예약·고객관리 솔루션', 'PHP, Laravel, React, 결제 연동'],
  ['에이아이툴박스', 'individual', 'individual', 'AI를 활용한 업무 도구를 만드는 개인 개발자', 'Python, LLM, RAG'],
  ['앱짓는사람', 'individual', 'individual', '모바일 앱 개인 개발자', 'Flutter, React Native'],
  ['데브킷스튜디오', 'sole', 'general', '교육 콘텐츠와 개발 도구·플러그인', 'TypeScript, VS Code 확장, 교육'],
];
// [판매자 번호, 분야, 유형, 사용 환경, 상품명, 한 줄 설명, 가격]
const PRODUCTS = [
  [1, 'erp', 'license', 'web', '소규모 제조업 ERP 라이트', '수주·생산·출하를 한 화면에서 관리하는 웹 ERP', 1650000],
  [1, 'erp', 'source', 'web', '그룹웨어 전자결재 모듈', '기안·결재선·반려·보관함을 갖춘 전자결재 소스', 2200000],
  [1, 'erp', 'license', 'web', '근태·연차 관리 시스템', '출퇴근 기록과 연차 자동 계산', 440000],
  [1, 'erp', 'source', 'web', '사내 게시판·공지 모듈', '부서별 권한이 있는 게시판 소스', 330000],
  [1, 'erp', 'license', 'web', '프로젝트 원가 관리', '프로젝트별 투입 인력과 원가 집계', 880000],
  [1, 'erp', 'source', 'web', '조직도·인사카드 모듈', '조직도 편집과 인사 기록 관리 소스', 550000],
  [0, 'construction', 'license', 'pc', '전기공사 내역서 작성기', '단가표 기반 전기공사 내역서 작성 프로그램', 297000],
  [0, 'construction', 'source', 'web', '착공계 서류 자동 생성', '공사 정보 입력으로 착공계 서류 일괄 생성', 990000],
  [0, 'construction', 'license', 'pc', '통신공사 준공 서류 도우미', '준공 사진 대지와 준공 서류 묶음 출력', 220000],
  [0, 'construction', 'license', 'web', '현장 안전점검 체크리스트', '모바일로 점검하고 PDF 보고서로 출력', 385000],
  [0, 'construction', 'source', 'web', '공사 일보 관리 시스템', '현장별 일보 입력·승인·월간 집계 소스', 1320000],
  [0, 'construction', 'license', 'pc', '자재 물량 산출 도구', '도면 수량표를 엑셀 산출서로 변환', 165000],
  [0, 'construction', 'license', 'web', '하도급 기성 관리', '하도급 계약과 기성 청구 관리', 660000],
  [2, 'accounting', 'source', 'web', '견적서·거래명세서 발행기', '거래처별 견적서와 거래명세서 PDF 발행 소스', 770000],
  [2, 'accounting', 'license', 'web', '소상공인 재고 관리', '입출고·재고 실사·안전재고 알림', 198000],
  [2, 'accounting', 'license', 'pc', '발주서 자동 작성 프로그램', '재고 부족 품목으로 발주서 자동 작성', 143000],
  [2, 'accounting', 'source', 'web', '매입·매출 장부 모듈', '세금계산서 내역을 가져와 장부로 정리하는 소스', 1100000],
  [2, 'accounting', 'license', 'web', '미수금 관리 대시보드', '거래처별 미수금과 회수 일정 관리', 275000],
  [2, 'accounting', 'license', 'web', '급여 명세서 발송 도구', '급여 대장으로 명세서를 만들어 개별 발송', 330000],
  [3, 'automation', 'license', 'pc', 'PDF 일괄 병합·분할 도구', '폴더 단위로 PDF를 병합·분할·페이지 추출', 55000],
  [3, 'automation', 'source', 'pc', '엑셀 보고서 자동화 스크립트 모음', '반복 보고서를 만드는 파이썬 스크립트 20종', 132000],
  [3, 'automation', 'license', 'pc', '스캔 문서 OCR 정리기', '스캔 PDF를 검색 가능한 문서로 변환', 242000],
  [3, 'automation', 'source', 'web', '계약서 양식 채우기 엔진', '워드 양식에 데이터를 채워 계약서를 생성하는 소스', 660000],
  [3, 'automation', 'license', 'pc', '엑셀 중복·오류 검사기', '대량 엑셀의 중복과 형식 오류 검사', 44000],
  [3, 'automation', 'license', 'web', '문서 번호 채번 시스템', '부서별 문서 번호 자동 채번과 대장 관리', 176000],
  [3, 'automation', 'source', 'pc', '메일 첨부 자동 분류기', '메일 첨부 파일을 규칙에 따라 폴더로 정리하는 소스', 220000],
  [4, 'commerce', 'source', 'web', '소형 쇼핑몰 풀 패키지', '상품·주문·배송·관리자 화면을 갖춘 쇼핑몰 소스', 3300000],
  [4, 'commerce', 'license', 'web', '미용실 예약 관리', '디자이너별 예약과 알림', 264000],
  [4, 'commerce', 'license', 'web', '학원 수강생 관리', '수강 등록·출결·수납 관리', 396000],
  [4, 'commerce', 'source', 'web', '고객 상담 이력 CRM', '상담 기록과 후속 일정 관리 CRM 소스', 880000],
  [4, 'commerce', 'license', 'web', '펜션 객실 예약 시스템', '객실 달력과 예약 관리', 330000],
  [4, 'commerce', 'source', 'web', '쿠폰·적립금 모듈', '쇼핑몰에 붙이는 쿠폰·적립금 소스', 495000],
  [4, 'commerce', 'license', 'web', '식당 테이블 주문 시스템', 'QR 주문과 주방 화면', 550000],
  [5, 'ai', 'source', 'web', '사내 문서 질의응답 챗봇', '사내 문서를 검색해 답하는 챗봇 소스', 1980000],
  [5, 'ai', 'license', 'web', '회의록 요약 도구', '녹취 텍스트를 회의록과 할 일로 정리', 165000],
  [5, 'ai', 'source', 'pc', '상품 설명 생성 스크립트', '상품 속성으로 설명 초안을 만드는 스크립트', 99000],
  [5, 'ai', 'license', 'web', '고객 문의 분류기', '문의를 유형별로 분류하고 답변 초안 제시', 440000],
  [5, 'ai', 'source', 'web', '견적 요청 메일 분석기', '견적 요청 메일에서 품목과 수량 추출 소스', 550000],
  [5, 'ai', 'license', 'web', '이미지 배경 제거 서비스', '상품 사진 배경 일괄 제거', 110000],
  [6, 'mobile', 'source', 'mobile', '배달 기사용 앱 템플릿', '배차·경로·완료 처리 앱 소스', 1650000],
  [6, 'mobile', 'license', 'mobile', '현장 사진 보고 앱', '사진과 위치를 찍어 보고서로 전송', 220000],
  [6, 'mobile', 'source', 'mobile', '회원제 커뮤니티 앱', '게시판·채팅·알림을 갖춘 앱 소스', 2750000],
  [6, 'mobile', 'license', 'mobile', '방문 점검 체크 앱', '방문 점검 항목 기록과 서명', 187000],
  [6, 'mobile', 'source', 'mobile', '예약·결제 앱 스타터', '예약과 결제 흐름이 있는 앱 시작 소스', 1320000],
  [7, 'education', 'license', 'web', '온라인 강의 수강 사이트', '강의 영상·진도·수료증', 990000],
  [7, 'education', 'source', 'web', '퀴즈·시험 출제 모듈', '문항 은행과 자동 채점 소스', 440000],
  [7, 'education', 'license', 'web', '사내 교육 이수 관리', '법정 교육 이수 현황 관리', 308000],
  [7, 'devtools', 'source', 'pc', 'API 문서 자동 생성기', '코드 주석으로 API 문서를 만드는 도구 소스', 154000],
  [7, 'devtools', 'license', 'pc', '로그 검색 뷰어', '대용량 로그 파일 검색·필터 프로그램', 66000],
  [7, 'devtools', 'source', 'pc', '코드 스니펫 관리 플러그인', '에디터용 스니펫 관리 플러그인 소스', 77000],
];
const PLATFORM_ENV = { web: 'Node.js 20 이상 또는 Docker, PostgreSQL 15 / 최신 Chrome·Edge', pc: 'Windows 10·11 (64비트)', mobile: 'Android 10 이상, iOS 15 이상' };

(async () => {
  if (q.get("SELECT 1 FROM users WHERE email LIKE '%@demo.eum.test'")) { console.log('이미 시연용 데이터가 있습니다. 다시 만들려면 data 폴더를 지운 뒤 실행하세요.'); return; }
  const session = (id) => accounts.sessionUser(accounts.createSession(id));
  const mk = (email, name) => session(accounts.register({ email, password: PW, name }).id);
  let adminRow = q.get("SELECT user_id FROM staff_roles WHERE role = 'super' LIMIT 1");
  if (!adminRow) { const a = mk('admin@demo.eum.test', '시연 운영자'); q.run("INSERT INTO staff_roles (user_id, role, granted_at) VALUES (?, 'super', ?)", a.id, clock.iso()); adminRow = { user_id: a.id }; }
  const admin = session(adminRow.user_id);
  const buyers = ['가온건설', '다온전기', '라온유통', '마루학원', '바른회계'].map((n, i) => mk(`buyer${i + 1}@demo.eum.test`, n + ' 담당자'));
  const sellers = SELLERS.map(([name, bizType, taxType, intro, skills], i) => {
    let u = mk(`seller${i + 1}@demo.eum.test`, name.replace(' 데모', '') + ' 대표');
    accounts.applySeller(u, { displayName: name, intro: intro + ' (시연용 가공 판매자)', skills, portfolio: '시연용 가공 데이터입니다', bizType, taxType });
    accounts.reviewSeller(admin, u.id, { status: 'approved', note: '시연용' });
    u = session(u.id);
    accounts.setBankAccount(u, { bank: '시연은행', account: `1000000000${i}0`, holder: name });
    return session(u.id);
  });
  const file = (s, name, text) => storage.saveBuffer(Buffer.from(text), { originalName: name, uploaderId: s.id, purpose: 'product' });

  let done = 0;
  for (const [si, cat, type, platform, title, summary, price] of PRODUCTS) {
    const s = sellers[si];
    const isSrc = type === 'source';
    const pid = catalog.saveProduct(s, null, {
      type, platform, category_id: q.get('SELECT id FROM categories WHERE slug = ?', cat).id, title, summary,
      problem: `${summary} 업무를 수작업으로 처리하면서 생기는 누락과 반복 작업을 줄입니다.`,
      description: `${title}입니다. ${summary}. 시연을 위해 만든 가공 상품이며 실제 판매 상품이 아닙니다.`,
      features: '기본 자료 등록·조회\n엑셀 가져오기·내보내기\nPDF 출력\n사용자별 권한',
      included: isSrc ? '전체 소스코드\n설치 설명서\n환경변수 예시 파일' : (platform === 'pc' ? '설치 파일\n이용 안내' : '이용 계정\n이용 안내'),
      excluded: isSrc ? '서버 운영\n기능 추가 개발\n디자인 변경' : '소스코드\n맞춤 수정',
      environments: PLATFORM_ENV[platform], install_method: isSrc ? '설치 설명서의 순서대로 설치' : '안내 문서 참고',
      customizable: isSrc ? 1 : 0, lic_modify: isSrc ? 1 : 0, lic_commercial: 1,
      license_notes: isSrc ? '구매한 회사의 내부 사용과 자사 서비스 탑재 가능. 소스 자체의 재배포·재판매 불가' : '구매한 사용자 수·기기 수 범위에서 사용',
      update_support: '구매 후 6개월간 오류 수정', inspection_criteria: '1. 안내 문서대로 설치·접속된다\n2. 기본 자료 등록과 조회가 된다\n3. 출력 기능이 동작한다',
      inspection_days: 7, refund_policy: '검수 기간 안에 검수 기준과 다른 점을 문제 제기하면 수정 또는 환불을 협의합니다',
    });
    const opt = catalog.saveOption(s, pid, isSrc ? { name: '소스 포함 · 영구 사용', price, includes_source: 1 } : { name: platform === 'web' ? '사용자 10명 · 1년' : '기기 1대 · 영구', price, term: platform === 'web' ? 'term' : 'perpetual', term_days: 365, seats: platform === 'web' ? 10 : '', devices: platform === 'web' ? '' : 1 });
    if (isSrc) {
      catalog.addVersionFile(s, pid, await file(s, `demo-${pid}-source.txt`, `// 시연용 가공 파일 — ${title}\n// 실제 소스코드가 아닙니다.\n`), 'source');
      catalog.addVersionFile(s, pid, await file(s, 'INSTALL.md', `# ${title} 설치\n시연용 가공 문서입니다.\n`), 'install_doc');
    } else {
      if (platform !== 'web') catalog.addVersionFile(s, pid, await storage.saveBuffer(Buffer.from([0x4d, 0x5a, 0x90, 0, pid & 255, 1, 2, 3]), { originalName: `demo-${pid}-setup.bin`, uploaderId: s.id, purpose: 'product' }), 'executable');
      catalog.addVersionFile(s, pid, await file(s, 'guide.md', `# ${title} 이용 안내\n시연용 가공 문서입니다.\n`), 'guide');
    }
    catalog.submitVersion(s, pid, { label: '1.0.0' });
    catalog.submitForReview(s, pid);
    catalog.reviewProduct(admin, pid, { approve: true, note: '시연용' });
    // 거래 완료 주문 1건: 테스트 결제 → 구매확정 → 정산 지급
    const buyer = buyers[done % buyers.length];
    const o = orders.createProductOrder(buyer, { productId: pid, optionId: opt, agreed: true });
    const pay = await orders.startPayment(o, buyer);
    await sandbox.simulate(pay.providerPaymentId, { result: 'success', method: 'card' });
    inspection.confirm(buyer, o.id, { checklist: { files: true, install: true, features: true }, note: '시연용 거래' });
    await settlement.requestPayout(admin, o.id);
    done++;
  }
  await settlement.tick();
  q.run('UPDATE notifications SET read_at = ? WHERE read_at IS NULL', clock.iso());
  const paid = q.get("SELECT COUNT(*) c FROM orders WHERE payout_status = 'paid'").c;
  console.log(`시연용 가공 데이터 생성 완료: 상품 ${done}개, 정산까지 끝난 테스트 주문 ${paid}건`);
  console.log(`시연 계정(비밀번호 ${PW}): seller1~8@demo.eum.test, buyer1~5@demo.eum.test`);
})().catch((e) => { console.error(e); process.exit(1); });
