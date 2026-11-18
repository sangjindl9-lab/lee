-- 이음마켓 초기 스키마. 금액은 모두 원(KRW) 정수. 시각은 UTC ISO-8601 문자열.

-- ───────── 회원 · 권한 ─────────
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','withdrawn')),
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  withdrawn_at TEXT
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  csrf TEXT NOT NULL,
  mfa_ok INTEGER NOT NULL DEFAULT 0,
  reauth_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
-- 운영자 권한: review(심사) support(고객지원) settlement(정산) super(최고관리자)
CREATE TABLE staff_roles (
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('review','support','settlement','super')),
  granted_by INTEGER, granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);
CREATE TABLE companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, biz_no TEXT NOT NULL DEFAULT '',
  require_approval INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE company_members (
  company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('admin','buyer','inspector')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (company_id, user_id)
);
CREATE TABLE purchase_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  requester_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER NOT NULL, option_id INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','used')),
  decided_by INTEGER, decided_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE seller_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  display_name TEXT NOT NULL,
  intro TEXT NOT NULL DEFAULT '',
  skills TEXT NOT NULL DEFAULT '',
  portfolio TEXT NOT NULL DEFAULT '',
  biz_type TEXT NOT NULL DEFAULT 'individual' CHECK (biz_type IN ('individual','sole','corp')),
  biz_no TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','suspended')),
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_by INTEGER, reviewed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE seller_bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES users(id),
  bank TEXT NOT NULL, account_enc TEXT NOT NULL, account_last4 TEXT NOT NULL, holder TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','replaced')),
  payout_hold_until TEXT,           -- 계좌 변경 직후 지급 보류 시각
  created_at TEXT NOT NULL
);

-- ───────── 상품 · 파일 ─────────
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  key_id TEXT NOT NULL, wrapped_key TEXT NOT NULL, iv TEXT NOT NULL, auth_tag TEXT NOT NULL,
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL,            -- product | delivery | evidence | ip_private | message
  -- 검사 항목은 서로 독립: pending / scanning / passed / flagged / unscannable
  scan_malware TEXT NOT NULL DEFAULT 'pending',
  scan_secrets TEXT NOT NULL DEFAULT 'pending',
  scan_archive TEXT NOT NULL DEFAULT 'pending',
  scan_report TEXT NOT NULL DEFAULT '{}',
  scanned_at TEXT,
  scan_override_by INTEGER, scan_override_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('license','source')),   -- 사용권 / 소스코드
  category_id INTEGER REFERENCES categories(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  problem TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  features TEXT NOT NULL DEFAULT '',
  included TEXT NOT NULL DEFAULT '',
  excluded TEXT NOT NULL DEFAULT '',
  screenshots TEXT NOT NULL DEFAULT '',      -- 줄바꿈으로 구분한 이미지 URL
  video_url TEXT NOT NULL DEFAULT '',
  demo_url TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT 'web' CHECK (platform IN ('pc','web','mobile','etc')),
  environments TEXT NOT NULL DEFAULT '',
  install_method TEXT NOT NULL DEFAULT '',
  install_support INTEGER NOT NULL DEFAULT 0,
  install_done_criteria TEXT NOT NULL DEFAULT '',
  customizable INTEGER NOT NULL DEFAULT 0,
  external_paid_required INTEGER NOT NULL DEFAULT 0,
  external_costs TEXT NOT NULL DEFAULT '',
  third_party_licenses TEXT NOT NULL DEFAULT '',
  -- 권리 범위(소스 구매 시 의미 있음). 권리 양도는 지식재산권 거래에서만 다룬다.
  lic_modify INTEGER NOT NULL DEFAULT 0,
  lic_commercial INTEGER NOT NULL DEFAULT 0,
  lic_redistribute INTEGER NOT NULL DEFAULT 0,
  lic_resale INTEGER NOT NULL DEFAULT 0,
  license_notes TEXT NOT NULL DEFAULT '',
  update_support TEXT NOT NULL DEFAULT '',
  inspection_criteria TEXT NOT NULL DEFAULT '',
  inspection_days INTEGER NOT NULL DEFAULT 7,
  refund_policy TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','approved','rejected','suspended','deleted')),
  sales_blocked INTEGER NOT NULL DEFAULT 0,
  sales_blocked_reason TEXT NOT NULL DEFAULT '',
  review_note TEXT NOT NULL DEFAULT '',
  current_version_id INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_products_list ON products(status, type, category_id);
CREATE TABLE product_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price > 0),
  term TEXT NOT NULL DEFAULT 'perpetual' CHECK (term IN ('perpetual','term')),
  term_days INTEGER,
  seats INTEGER, devices INTEGER,
  includes_source INTEGER NOT NULL DEFAULT 0,
  includes_install INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE product_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  label TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  manifest_hash TEXT,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL, submitted_at TEXT
);
CREATE TABLE product_version_files (
  version_id INTEGER NOT NULL REFERENCES product_versions(id),
  file_id INTEGER NOT NULL REFERENCES files(id),
  role TEXT NOT NULL CHECK (role IN ('executable','source','install_doc','dependencies','env_example','db_schema','license_notice','guide','other')),
  PRIMARY KEY (version_id, file_id)
);
-- 제출된 버전의 파일 목록은 DB 차원에서도 바꿀 수 없다.
CREATE TRIGGER pvf_no_insert BEFORE INSERT ON product_version_files
WHEN (SELECT status FROM product_versions WHERE id = NEW.version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'VERSION_FROZEN'); END;
CREATE TRIGGER pvf_no_delete BEFORE DELETE ON product_version_files
WHEN (SELECT status FROM product_versions WHERE id = OLD.version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'VERSION_FROZEN'); END;
CREATE TRIGGER pvf_no_update BEFORE UPDATE ON product_version_files
BEGIN SELECT RAISE(ABORT, 'VERSION_FROZEN'); END;
CREATE TRIGGER files_no_content_update BEFORE UPDATE OF storage_key, sha256, size, wrapped_key, iv, auth_tag ON files
BEGIN SELECT RAISE(ABORT, 'FILE_IMMUTABLE'); END;

-- 검증 범위 기록(항목별로 따로, 어느 하나가 전체 품질 보증을 뜻하지 않음)
CREATE TABLE product_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  version_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('build_check','run_check','rights_docs')),
  result TEXT NOT NULL CHECK (result IN ('passed','failed')),
  scope_note TEXT NOT NULL,
  by_user INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE favorites (
  user_id INTEGER NOT NULL, product_id INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

-- ───────── 수수료 정책 · 설정 ─────────
CREATE TABLE fee_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('default','category','seller')),
  scope_id INTEGER,
  rate_bps INTEGER NOT NULL CHECK (rate_bps BETWEEN 0 AND 5000),
  label TEXT NOT NULL DEFAULT '',
  starts_at TEXT, ends_at TEXT,          -- 할인 기간(없으면 상시)
  created_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by INTEGER, updated_at TEXT);
CREATE TABLE pg_capability_checks (
  provider TEXT NOT NULL, item TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','supported','unsupported')),
  value TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '',
  checked_by INTEGER, checked_at TEXT,
  PRIMARY KEY (provider, item)
);

-- ───────── 맞춤 개발 ─────────
CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'new' CHECK (kind IN ('new','customize','install','integration','maintenance')),
  related_product_id INTEGER,
  title TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '', requirements TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL DEFAULT '',
  budget_min INTEGER, budget_max INTEGER, due_date TEXT,
  reference_notes TEXT NOT NULL DEFAULT '',
  source_terms TEXT NOT NULL DEFAULT '', rights_terms TEXT NOT NULL DEFAULT '', maintenance_terms TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  invited_seller_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','contracting','closed','cancelled')),
  created_at TEXT NOT NULL
);
CREATE TABLE proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL, exclusions TEXT NOT NULL DEFAULT '',
  revision_scope TEXT NOT NULL DEFAULT '', support_terms TEXT NOT NULL DEFAULT '',
  milestones_json TEXT NOT NULL,       -- [{title, deliverables, amount, days, criteria, requires_source}]
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','accepted','declined','withdrawn')),
  created_at TEXT NOT NULL,
  UNIQUE (request_id, seller_id)
);
CREATE TABLE contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER REFERENCES requests(id),
  proposal_id INTEGER REFERENCES proposals(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','completed','cancelled')),
  current_version_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE contract_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  version_no INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('initial','change')),
  terms_json TEXT NOT NULL, terms_hash TEXT NOT NULL,
  change_summary TEXT NOT NULL DEFAULT '',
  proposed_by INTEGER NOT NULL,
  buyer_agreed_at TEXT, seller_agreed_at TEXT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','agreed','rejected','superseded')),
  created_at TEXT NOT NULL,
  UNIQUE (contract_id, version_no)
);
CREATE TRIGGER contract_versions_frozen BEFORE UPDATE OF terms_json, terms_hash ON contract_versions
BEGIN SELECT RAISE(ABORT, 'CONTRACT_VERSION_FROZEN'); END;
CREATE TABLE milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  seq INTEGER NOT NULL,
  title TEXT NOT NULL, deliverables TEXT NOT NULL DEFAULT '', criteria TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL CHECK (amount > 0), days INTEGER NOT NULL DEFAULT 14,
  requires_source INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','awaiting_payment','in_progress','delivered','revision','approved','cancelled')),
  order_id INTEGER,
  added_in_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (contract_id, seq)
);

-- ───────── 지식재산권 ─────────
CREATE TABLE ip_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, public_summary TEXT NOT NULL DEFAULT '',
  right_type TEXT NOT NULL,            -- 저작재산권 / 특허·상표 등 기타 권리 / 사업 자산
  subject TEXT NOT NULL DEFAULT '',
  holder TEXT NOT NULL DEFAULT '', authority TEXT NOT NULL DEFAULT '',
  co_owners TEXT NOT NULL DEFAULT '',
  deal_type TEXT NOT NULL CHECK (deal_type IN ('assignment','exclusive_license','nonexclusive_license','consult')),
  scope TEXT NOT NULL DEFAULT '', term TEXT NOT NULL DEFAULT '', territory TEXT NOT NULL DEFAULT '', field_of_use TEXT NOT NULL DEFAULT '',
  existing_licenses TEXT NOT NULL DEFAULT '', third_party TEXT NOT NULL DEFAULT '',
  included_assets TEXT NOT NULL DEFAULT '', excluded_assets TEXT NOT NULL DEFAULT '',
  existing_sales_handling TEXT NOT NULL DEFAULT '',
  asking_price INTEGER,
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('draft','pending_review','approved','rejected','suspended','sold','deleted')),
  locked_deal_id INTEGER,              -- 독점 거래 진행 중 잠금
  review_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE ip_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES ip_listings(id),
  file_id INTEGER NOT NULL REFERENCES files(id),
  title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'evidence',
  created_at TEXT NOT NULL
);
CREATE TABLE ip_deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES ip_listings(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'inquiry' CHECK (status IN ('inquiry','nda_pending','data_room','terms_proposed','terms_agreed','paid','transfer','rights_check','completed','cancelled')),
  inquiry TEXT NOT NULL DEFAULT '',
  nda_text TEXT, nda_hash TEXT, nda_buyer_at TEXT, nda_seller_at TEXT,
  access_approved_at TEXT,
  terms_json TEXT, terms_hash TEXT, terms_proposed_by INTEGER, terms_buyer_at TEXT, terms_seller_at TEXT,
  price INTEGER,
  rights_procedure_note TEXT NOT NULL DEFAULT '', rights_buyer_at TEXT, rights_seller_at TEXT,
  order_id INTEGER,
  created_at TEXT NOT NULL, cancelled_reason TEXT
);
CREATE TABLE ip_transfer_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES ip_deals(id),
  asset_type TEXT NOT NULL CHECK (asset_type IN ('repo','snapshot','build_docs','design','domain','service_account','contracts','other')),
  description TEXT NOT NULL,
  official_procedure TEXT NOT NULL DEFAULT '',   -- 서비스 제공자의 공식 이전 절차 확인 내용
  file_id INTEGER,
  seller_done_at TEXT, seller_note TEXT NOT NULL DEFAULT '',
  buyer_confirmed_at TEXT
);
CREATE TABLE ip_access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL, user_id INTEGER NOT NULL, document_id INTEGER NOT NULL,
  ip TEXT, created_at TEXT NOT NULL
);

-- ───────── 주문 · 결제 ─────────
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('product','milestone','ip')),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  company_id INTEGER,
  product_id INTEGER, option_id INTEGER, version_id INTEGER,
  milestone_id INTEGER, ip_deal_id INTEGER,
  title TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  -- 주문 시점에 고정되는 조건
  snapshot_json TEXT NOT NULL, terms_hash TEXT NOT NULL,
  fee_bps INTEGER NOT NULL, fee_amount INTEGER NOT NULL, fee_vat INTEGER NOT NULL,
  pg_fee_bps INTEGER NOT NULL, pg_fee_amount INTEGER NOT NULL,
  pg_fee_bearer TEXT NOT NULL CHECK (pg_fee_bearer IN ('platform','seller')),
  inspection_days INTEGER NOT NULL,
  delivery_days INTEGER NOT NULL DEFAULT 0,
  extra_verification INTEGER NOT NULL DEFAULT 0,       -- 고액·권리 양도 거래 별도 확인
  extra_verified_by INTEGER, extra_verified_at TEXT,
  -- 서로 독립적인 상태
  payment_status TEXT NOT NULL DEFAULT 'none' CHECK (payment_status IN ('none','pending','paid','partially_refunded','refunded','failed','cancelled')),
  protection_status TEXT NOT NULL DEFAULT 'none' CHECK (protection_status IN ('none','simulated','held','released','unsupported','unknown')),
  delivery_status TEXT NOT NULL DEFAULT 'not_ready' CHECK (delivery_status IN ('not_ready','awaiting_seller','delivered','access_failed','redelivery_requested')),
  inspection_status TEXT NOT NULL DEFAULT 'not_started' CHECK (inspection_status IN ('not_started','in_progress','approved','auto_approved','closed_by_admin','rejected')),
  dispute_status TEXT NOT NULL DEFAULT 'none' CHECK (dispute_status IN ('none','open','resolved')),
  refund_status TEXT NOT NULL DEFAULT 'none' CHECK (refund_status IN ('none','requested','processing','completed','failed','rejected','manual_required')),
  payout_status TEXT NOT NULL DEFAULT 'not_eligible' CHECK (payout_status IN ('not_eligible','eligible','requested','unknown','paid','failed','held','clawback_review')),
  refunded_amount INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT, delivery_due_at TEXT, delivered_at TEXT,
  inspection_started_at TEXT, inspection_due_at TEXT, confirmed_at TEXT, confirmed_by INTEGER,
  install_done_at TEXT,
  close_review_requested_at TEXT,          -- 판매자의 검수 종료 심사 요청
  payout_hold_until TEXT,
  use_termination_ack_at TEXT,             -- 환불 후 구매자의 삭제·이용중단 확인
  created_at TEXT NOT NULL
);
CREATE INDEX idx_orders_buyer ON orders(buyer_id);
CREATE INDEX idx_orders_seller ON orders(seller_id);
CREATE TRIGGER orders_snapshot_frozen BEFORE UPDATE OF snapshot_json, terms_hash, version_id, amount, fee_bps, fee_amount, fee_vat, pg_fee_bps, pg_fee_bearer, buyer_id, seller_id, inspection_days ON orders
BEGIN SELECT RAISE(ABORT, 'ORDER_TERMS_FROZEN'); END;

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL, mode TEXT NOT NULL,         -- test | live
  provider_payment_id TEXT,
  method TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',             -- 내부 상태
  provider_status TEXT NOT NULL DEFAULT '',           -- 외부 사업자가 응답한 상태 원문
  provider_refunded INTEGER NOT NULL DEFAULT 0,
  provider_fee INTEGER,
  paid_at TEXT, last_synced_at TEXT, created_at TEXT NOT NULL,
  UNIQUE (provider, provider_payment_id)
);
CREATE UNIQUE INDEX idx_payments_one_live ON payments(order_id) WHERE status IN ('pending','paid');
CREATE TABLE protection_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL,
  state TEXT NOT NULL,                 -- 사업자 응답 기준
  hold_until TEXT, auto_confirm_at TEXT,
  hold_request TEXT NOT NULL DEFAULT 'none',   -- none / requested / confirmed / failed / unsupported
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL, event_id TEXT NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL,
  occurred_at TEXT, received_at TEXT NOT NULL, processed_at TEXT, result TEXT,
  UNIQUE (provider, event_id)
);

-- ───────── 납품 · 접근 권한 ─────────
CREATE TABLE entitlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  granted_at TEXT NOT NULL, revoked_at TEXT, revoke_reason TEXT
);
CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  seq INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '', run_instructions TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','rejected')),
  missing_json TEXT NOT NULL DEFAULT '[]',
  submitted_by INTEGER NOT NULL, created_at TEXT NOT NULL, submitted_at TEXT,
  UNIQUE (order_id, seq)
);
CREATE TABLE delivery_files (
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
  file_id INTEGER NOT NULL REFERENCES files(id),
  role TEXT NOT NULL,
  PRIMARY KEY (delivery_id, file_id)
);
CREATE TRIGGER df_no_insert BEFORE INSERT ON delivery_files
WHEN (SELECT status FROM deliveries WHERE id = NEW.delivery_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'DELIVERY_FROZEN'); END;
CREATE TRIGGER df_no_delete BEFORE DELETE ON delivery_files
WHEN (SELECT status FROM deliveries WHERE id = OLD.delivery_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'DELIVERY_FROZEN'); END;
CREATE TABLE download_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL, order_id INTEGER, file_id INTEGER NOT NULL,
  context TEXT NOT NULL,               -- order | seller | admin | ip | evidence
  expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE download_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, order_id INTEGER, file_id INTEGER,
  context TEXT NOT NULL, result TEXT NOT NULL,   -- ok | denied:<사유>
  ip TEXT, user_agent TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_dl_order ON download_logs(order_id);

-- ───────── 검수 · 수정 요청 ─────────
CREATE TABLE inspection_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  actor_id INTEGER, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE revision_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  requester_id INTEGER NOT NULL,
  criteria_ref TEXT NOT NULL DEFAULT '',     -- 어떤 계약 기준에 대한 요청인지
  content TEXT NOT NULL,
  scope_class TEXT NOT NULL DEFAULT 'undetermined' CHECK (scope_class IN ('undetermined','in_scope','out_of_scope')),
  classified_by INTEGER, seller_response TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','declined','quoted','done')),
  created_at TEXT NOT NULL, responded_at TEXT
);

-- ───────── 분쟁 · 환불 ─────────
CREATE TABLE disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  opened_by INTEGER NOT NULL,
  reason_code TEXT NOT NULL,
  description TEXT NOT NULL,
  requested_outcome TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','admin_review','resolved','appealed','external')),
  post_payout INTEGER NOT NULL DEFAULT 0,
  external_hold TEXT NOT NULL DEFAULT 'none' CHECK (external_hold IN ('none','requested','confirmed','failed','unsupported','not_applicable')),
  external_hold_detail TEXT NOT NULL DEFAULT '',
  resolution TEXT,                      -- refund_full / refund_partial / resume / release / external
  resolution_amount INTEGER, resolution_reason TEXT,
  resolved_by INTEGER, resolved_at TEXT, appeal_deadline TEXT,
  appeal_by INTEGER, appeal_text TEXT, appeal_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_dispute_one_open ON disputes(order_id) WHERE status IN ('open','admin_review','appealed');
CREATE TABLE dispute_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id INTEGER NOT NULL REFERENCES disputes(id),
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('statement','evidence','proposal','proposal_accept','proposal_decline','admin_note')),
  body TEXT NOT NULL DEFAULT '', file_id INTEGER,
  proposal_type TEXT, proposal_amount INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  dispute_id INTEGER,
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','processing','completed','failed','rejected','manual_required')),
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_refund_id TEXT, provider_status TEXT NOT NULL DEFAULT '',
  seller_share INTEGER, fee_share INTEGER, pg_fee_share INTEGER,
  requested_by INTEGER NOT NULL, decided_by INTEGER, decision_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, completed_at TEXT
);
CREATE UNIQUE INDEX idx_refund_one_active ON refunds(order_id) WHERE status IN ('requested','processing');

-- ───────── 원장 · 정산 ─────────
CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn TEXT NOT NULL,                    -- 묶음 ID. 한 묶음의 amount 합은 0
  order_id INTEGER NOT NULL REFERENCES orders(id),
  account TEXT NOT NULL CHECK (account IN ('pg_holding','seller_payable','platform_fee','pg_cost_passthrough','refund_in_transit','payout_in_transit')),
  amount INTEGER NOT NULL,              -- 차변 +, 대변 −
  event TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ledger_order ON ledger_entries(order_id, account);
CREATE TRIGGER ledger_append_only_u BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'LEDGER_APPEND_ONLY'); END;
CREATE TRIGGER ledger_append_only_d BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'LEDGER_APPEND_ONLY'); END;
CREATE TABLE payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  seller_id INTEGER NOT NULL,
  bank_account_id INTEGER,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','requested','unknown','paid','failed')),
  method TEXT NOT NULL DEFAULT 'provider' CHECK (method IN ('provider','manual')),
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_payout_id TEXT, provider_status TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
  manual_evidence TEXT NOT NULL DEFAULT '',
  created_by INTEGER, created_at TEXT NOT NULL, requested_at TEXT, paid_at TEXT, last_checked_at TEXT
);
-- 주문당 진행 중이거나 완료된 지급은 1건뿐
CREATE UNIQUE INDEX idx_payout_one_live ON payouts(order_id) WHERE status IN ('created','requested','unknown','paid');
CREATE TABLE reconciliation_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, order_id INTEGER, ref TEXT NOT NULL DEFAULT '',
  internal_value TEXT NOT NULL, external_value TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  note TEXT NOT NULL DEFAULT '', resolved_by INTEGER,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, resolved_at TEXT
);
CREATE UNIQUE INDEX idx_recon_open ON reconciliation_issues(kind, order_id, ref) WHERE status = 'open';

-- ───────── 소통 · 후기 · 신고 · 지원 ─────────
CREATE TABLE threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('inquiry','order','request','ip')),
  ref_id INTEGER NOT NULL,
  user_a INTEGER NOT NULL, user_b INTEGER NOT NULL,
  subject TEXT NOT NULL, created_at TEXT NOT NULL, last_at TEXT NOT NULL,
  UNIQUE (kind, ref_id, user_a, user_b)
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  sender_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  product_id INTEGER, seller_id INTEGER NOT NULL, buyer_id INTEGER NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL, seller_reply TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0, hidden_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('product','ip_listing','review','user','order')),
  target_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('rights_infringement','malware','fraud','redistribution','fake_review','other')),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','actioned','dismissed')),
  action_note TEXT NOT NULL DEFAULT '', handled_by INTEGER, handled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL, order_id INTEGER, product_id INTEGER,
  category TEXT NOT NULL DEFAULT 'general',
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  user_id INTEGER NOT NULL, is_staff INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT, read_at TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_notif_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER, actor_role TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}', ip TEXT, created_at TEXT NOT NULL
);
CREATE TRIGGER audit_append_only_u BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY'); END;
CREATE TRIGGER audit_append_only_d BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY'); END;
CREATE TABLE ai_consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL, kind TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL
);

-- ───────── 내장 테스트 결제 사업자(sandbox)의 "외부" 장부 ─────────
-- 실제 사업자의 시스템을 흉내 내는 별도 테이블. 플랫폼 로직은 provider 인터페이스로만 접근한다.
CREATE TABLE sandbox_payments (
  id TEXT PRIMARY KEY, order_no TEXT NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,                -- READY / PAID / FAILED / CANCELLED / PARTIAL_CANCELLED
  refunded INTEGER NOT NULL DEFAULT 0, fee INTEGER NOT NULL DEFAULT 0,
  escrow TEXT NOT NULL DEFAULT 'NONE', -- HELD / PAYOUT_BLOCKED / RELEASED
  hold_until TEXT, paid_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE sandbox_refunds (idem TEXT PRIMARY KEY, payment_id TEXT NOT NULL, amount INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE sandbox_payouts (
  idem TEXT PRIMARY KEY, id TEXT NOT NULL, payment_id TEXT NOT NULL, amount INTEGER NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL
);
