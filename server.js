'use strict';
const config = require('./src/config');
const db = require('./src/db');
db.init();
const accounts = require('./src/services/accounts');
const sandbox = require('./src/providers/sandbox');
const webhooks = require('./src/services/webhooks');
const jobs = require('./src/services/jobs');

accounts.ensureAdmin(config.adminEmail, config.adminPassword);
// 내장 테스트 사업자의 웹훅은 실제 웹훅과 같은 검증·처리 경로로 전달한다.
sandbox.state.deliver = (raw, headers) => webhooks.handle('sandbox', raw, headers);

const app = require('./src/app').build();
app.listen(config.port, () => {
  console.log(`이음마켓 실행: ${config.baseUrl} (결제 사업자: ${config.paymentProvider})`);
  jobs.start();
  // 시연 배포 전용: DEMO_DATA=1이면 가공 상품과 테스트 거래를 채운다(이미 있으면 건너뜀).
  if (process.env.DEMO_DATA === '1') {
    require('./scripts/seed-demo').run().catch((e) => console.error('[demo] 시연 데이터 생성 실패:', e.message));
  }
});
