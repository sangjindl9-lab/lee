'use strict';
// 개발·시연용 예시 데이터. 운영 DB에는 실행하지 마세요(NODE_ENV=production이면 중단).
// 가짜 후기·거래량은 만들지 않는다. 계정과 상품, 진행 중인 테스트 주문 1건만 만든다.
if (process.env.NODE_ENV === 'production') { console.error('운영 환경에서는 실행할 수 없습니다.'); process.exit(1); }
const db = require('../src/db'); db.init();
const { q } = db;
const { clock } = require('../src/util');
const accounts = require('../src/services/accounts');
const catalog = require('../src/services/catalog');
const orders = require('../src/services/orders');
const storage = require('../src/storage');
const sandbox = require('../src/providers/sandbox');
const webhooks = require('../src/services/webhooks');
sandbox.state.deliver = (raw, headers) => webhooks.handle('sandbox', raw, headers);

(async () => {
  if (q.get('SELECT 1 FROM users LIMIT 1')) { console.log('이미 데이터가 있어 건너뜁니다.'); return; }
  const pw = 'eum-demo-1234';
  const mk = (email, name) => accounts.sessionUser(accounts.createSession(accounts.register({ email, password: pw, name }).id));
  let admin = mk('admin@eum.test', '운영자');
  for (const r of ['super']) q.run('INSERT INTO staff_roles (user_id, role, granted_at) VALUES (?,?,?)', admin.id, r, clock.iso());
  admin = accounts.sessionUser(accounts.createSession(admin.id));
  let seller = mk('seller@eum.test', '김판매');
  const buyer = mk('buyer@eum.test', '이구매');
  accounts.applySeller(seller, { displayName: '한빛소프트웍스', intro: '건설·전기 현장 문서 자동화 도구를 만듭니다.', skills: 'Node.js, 엑셀 자동화, PDF', portfolio: '견적서 자동 생성 도구\n현장 일보 PDF 변환기', bizType: 'sole' });
  accounts.reviewSeller(admin, seller.id, { status: 'approved', note: '사업자 정보 확인' });
  seller = accounts.sessionUser(accounts.createSession(seller.id));
  accounts.setBankAccount(seller, { bank: '국민은행', account: '12345678901234', holder: '김판매' });
  const file = (name, text) => storage.saveBuffer(Buffer.from(text), { originalName: name, uploaderId: seller.id, purpose: 'product' });

  const pid = catalog.saveProduct(seller, null, {
    type: 'source', category_id: q.get("SELECT id FROM categories WHERE slug='accounting'").id, platform: 'web',
    title: '견적서 자동 생성기', summary: '엑셀 단가표를 올리면 견적서 PDF를 만들어 주는 웹 도구',
    problem: '현장마다 엑셀 견적서를 손으로 복사해 만들다 보니 단가 오류와 누락이 생깁니다.',
    description: '단가표(엑셀)를 등록하고 품목과 수량만 고르면 회사 서식의 견적서 PDF를 만듭니다.',
    features: '엑셀 단가표 가져오기\n품목·수량 선택 후 견적서 PDF 생성\n거래처별 견적 이력 조회',
    included: '전체 소스코드(Node.js)\n설치 설명서\nDB 마이그레이션 스크립트\n.env.example', excluded: '서버 호스팅과 운영\n회사 서식 디자인 변경\n기능 추가 개발',
    environments: 'Node.js 20 이상, SQLite 또는 PostgreSQL 15, Windows 10·macOS·Ubuntu 22.04', install_method: 'npm install 후 npm start. 설치 설명서 참고',
    install_support: 1, install_done_criteria: '구매자 서버에서 로그인 화면이 열리고 샘플 견적서 1건이 PDF로 출력됨', customizable: 1,
    external_paid_required: 0, third_party_licenses: 'pdfkit(MIT), exceljs(MIT)', lic_modify: 1, lic_commercial: 1,
    license_notes: '구매한 회사 내부 사용과 자사 서비스 탑재 가능. 소스 자체의 재배포·재판매는 불가', update_support: '구매 후 6개월간 버그 수정 제공',
    inspection_criteria: '1. 설치 설명서대로 실행된다\n2. 샘플 단가표를 가져올 수 있다\n3. 견적서 PDF가 생성된다', inspection_days: 7,
    refund_policy: '검수 기간 안에 검수 기준과 다른 점을 문제 제기하면 수정 또는 환불을 협의합니다.',
  });
  const opt = catalog.saveOption(seller, pid, { name: '소스 포함 · 영구 사용', price: '880000', includes_source: 1 });
  catalog.saveOption(seller, pid, { name: '소스 포함 · 설치 지원', price: '1100000', includes_source: 1, includes_install: 1 });
  catalog.addVersionFile(seller, pid, await file('quote-generator-src.txt', '// 예시 소스 묶음(시연용)\nconsole.log("견적서 생성기");\n'), 'source');
  catalog.addVersionFile(seller, pid, await file('INSTALL.md', '# 설치\n1. npm install\n2. cp .env.example .env\n3. npm start\n'), 'install_doc');
  catalog.addVersionFile(seller, pid, await file('.env.example', 'PORT=3000\nDATABASE_URL=\n'), 'env_example');
  catalog.submitVersion(seller, pid, { label: '1.0.0' });
  catalog.submitForReview(seller, pid);
  catalog.reviewProduct(admin, pid, { approve: true, note: '' });

  const pid2 = catalog.saveProduct(seller, null, {
    type: 'license', category_id: q.get("SELECT id FROM categories WHERE slug='construction'").id, platform: 'pc',
    title: '현장 일보 PDF 변환기', summary: '엑셀 현장 일보를 발주처 서식 PDF로 일괄 변환하는 PC 프로그램',
    description: '폴더를 지정하면 엑셀 일보를 PDF로 변환합니다.', features: '폴더 일괄 변환\n발주처 서식 3종', included: '설치 파일\n이용 안내', excluded: '소스코드\n서식 추가',
    environments: 'Windows 10·11 (64비트)', inspection_criteria: '샘플 일보 3건이 PDF로 변환된다', refund_policy: '검수 기간 내 문제 제기', inspection_days: 5,
  });
  catalog.saveOption(seller, pid2, { name: 'PC 1대 · 1년', price: '99000', term: 'term', term_days: 365, devices: 1 });
  catalog.addVersionFile(seller, pid2, await storage.saveBuffer(Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4]), { originalName: 'ilbo-setup.exe', uploaderId: seller.id, purpose: 'product' }), 'executable');
  catalog.addVersionFile(seller, pid2, await file('guide.md', '# 이용 안내\n설치 후 변환할 폴더를 선택하세요.\n'), 'guide');
  catalog.submitVersion(seller, pid2, { label: '2.3.1' });
  catalog.submitForReview(seller, pid2);
  catalog.reviewProduct(admin, pid2, { approve: true, note: '' });

  // 검수 중인 테스트 주문 1건
  const o = orders.createProductOrder(buyer, { productId: pid, optionId: opt, agreed: true });
  const r = await orders.startPayment(o, buyer);
  await sandbox.simulate(r.providerPaymentId, { result: 'success', method: 'card' });
  console.log(`예시 데이터 생성 완료. 계정(비밀번호 모두 ${pw}): admin@eum.test / seller@eum.test / buyer@eum.test`);
})().catch((e) => { console.error(e); process.exit(1); });
