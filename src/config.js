'use strict';
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// .env 파일이 있으면 읽는다(별도 패키지 없이).
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
const env = process.env;
const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

function secret(name, bytes) {
  if (env[name]) return env[name];
  if (isProd) throw new Error(`${name} 환경변수가 필요합니다(운영 환경).`);
  // 개발·테스트: DATA_DIR에 저장해 재시작해도 유지되게 한다.
  const dir = env.DATA_DIR || path.join(__dirname, '..', 'data');
  const f = path.join(dir, `.dev-${name.toLowerCase()}`);
  if (!isTest && fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const v = crypto.randomBytes(bytes).toString('hex');
  if (!isTest) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, v, { mode: 0o600 }); }
  return v;
}

const config = {
  isProd, isTest,
  port: Number(env.PORT || 3000),
  baseUrl: env.BASE_URL || `http://localhost:${env.PORT || 3000}`,
  dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),
  trustProxy: env.TRUST_PROXY === '1',
  cookieSecure: env.COOKIE_SECURE === '1',
  sessionSecret: secret('SESSION_SECRET', 32),
  fileMasterKey: secret('FILE_MASTER_KEY', 32),
  fileMasterKeyId: env.FILE_MASTER_KEY_ID || 'k1',
  adminEmail: env.ADMIN_EMAIL || '',
  adminPassword: env.ADMIN_PASSWORD || '',
  requireAdminMfa: env.REQUIRE_ADMIN_MFA ? env.REQUIRE_ADMIN_MFA === '1' : isProd,
  paymentProvider: env.PAYMENT_PROVIDER || 'sandbox',
  sandboxWebhookSecret: secret('SANDBOX_WEBHOOK_SECRET', 32),
  tossClientKey: env.TOSS_CLIENT_KEY || '',
  tossSecretKey: env.TOSS_SECRET_KEY || '',
  clamscanPath: env.CLAMSCAN_PATH || '',
  maxUploadBytes: Number(env.MAX_UPLOAD_MB || 200) * 1024 * 1024,
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  aiModel: env.AI_MODEL || 'claude-sonnet-5-5',
};
if (!/^[0-9a-f]{64}$/i.test(config.fileMasterKey)) throw new Error('FILE_MASTER_KEY는 64자리 hex여야 합니다.');
module.exports = config;
