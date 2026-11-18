-- 판매자 사업자 유형별 세무·증빙 처리

-- 과세 유형: general(법인·일반과세자) / simplified(간이과세자) / individual(개인·비사업자, 사업소득 원천징수 대상)
ALTER TABLE seller_profiles ADD COLUMN tax_type TEXT NOT NULL DEFAULT 'individual' CHECK (tax_type IN ('general','simplified','individual'));
ALTER TABLE seller_profiles ADD COLUMN simplified_invoice_ok INTEGER NOT NULL DEFAULT 0;   -- 간이과세자 중 세금계산서 수수 대상 여부
UPDATE seller_profiles SET tax_type = 'general' WHERE biz_type IN ('sole','corp');

-- 지급: 총 지급 대상액(gross)과 원천징수 세액, 실제 이체액(amount)을 구분
ALTER TABLE payouts ADD COLUMN gross_amount INTEGER;
ALTER TABLE payouts ADD COLUMN withholding_income INTEGER NOT NULL DEFAULT 0;   -- 소득세
ALTER TABLE payouts ADD COLUMN withholding_local INTEGER NOT NULL DEFAULT 0;    -- 지방소득세
ALTER TABLE payouts ADD COLUMN tax_type TEXT;
UPDATE payouts SET gross_amount = amount WHERE gross_amount IS NULL;

-- 원장에 원천징수 예수금 계정 추가(CHECK 제약 변경을 위해 테이블 재구성, 내용은 그대로 복사)
CREATE TABLE ledger_entries_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn TEXT NOT NULL,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  account TEXT NOT NULL CHECK (account IN ('pg_holding','seller_payable','platform_fee','pg_cost_passthrough','refund_in_transit','payout_in_transit','withholding_payable')),
  amount INTEGER NOT NULL,
  event TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
INSERT INTO ledger_entries_new SELECT * FROM ledger_entries;
DROP TABLE ledger_entries;
ALTER TABLE ledger_entries_new RENAME TO ledger_entries;
CREATE INDEX idx_ledger_order ON ledger_entries(order_id, account);
CREATE TRIGGER ledger_append_only_u BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'LEDGER_APPEND_ONLY'); END;
CREATE TRIGGER ledger_append_only_d BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'LEDGER_APPEND_ONLY'); END;

-- 세무 증빙 기초 데이터(실제 세금계산서 발행·지급명세서 제출은 외부 절차). 지급 완료 시 생성.
CREATE TABLE tax_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payout_id INTEGER NOT NULL REFERENCES payouts(id),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  seller_id INTEGER NOT NULL,
  seller_tax_type TEXT NOT NULL,
  -- fee_tax_invoice: 수수료 세금계산서 발행 대상 / fee_record: 세금계산서 대상 아님(정산 내역 기록) / withholding: 사업소득 원천징수(지급명세서 기초)
  doc_type TEXT NOT NULL CHECK (doc_type IN ('fee_tax_invoice','fee_record','withholding')),
  period TEXT NOT NULL,                 -- 귀속 연월(YYYY-MM, 한국 시간 지급일 기준)
  base_amount INTEGER NOT NULL,         -- 수수료(부가세 포함) 또는 지급 대상액
  supply_amount INTEGER NOT NULL DEFAULT 0,
  vat_amount INTEGER NOT NULL DEFAULT 0,
  income_tax INTEGER NOT NULL DEFAULT 0,
  local_tax INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','void')),
  issued_ref TEXT NOT NULL DEFAULT '', issued_by INTEGER, issued_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (payout_id, doc_type)
);
