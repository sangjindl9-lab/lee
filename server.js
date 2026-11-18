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
});
