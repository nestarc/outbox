-- Unified upgrade for @nestarc/outbox 0.1.x and 0.2.x installations.
-- Stop/drain old pollers before applying this file, then deploy the new runtime.

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS aggregate_type VARCHAR(255),
  ADD COLUMN IF NOT EXISTS aggregate_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS partition_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS causation_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

-- Older runtimes calculated retry eligibility in process memory. Preserve
-- liveness by making their already-retried active rows due at migration time.
UPDATE outbox_events
SET next_attempt_at = NOW()
WHERE status IN ('PENDING', 'PROCESSING')
  AND retry_count > 0
  AND next_attempt_at IS NULL;

-- Re-adding validates legacy rows before the new runtime starts. Repair or
-- quarantine invalid rows explicitly if this statement fails.
ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS chk_retry_count_nonnegative,
  DROP CONSTRAINT IF EXISTS chk_max_retries_positive,
  DROP CONSTRAINT IF EXISTS chk_payload_object,
  DROP CONSTRAINT IF EXISTS chk_headers_object,
  DROP CONSTRAINT IF EXISTS chk_nonprocessing_claim_clear,
  ADD CONSTRAINT chk_retry_count_nonnegative CHECK (retry_count >= 0),
  ADD CONSTRAINT chk_max_retries_positive CHECK (max_retries > 0),
  ADD CONSTRAINT chk_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  ADD CONSTRAINT chk_headers_object CHECK (jsonb_typeof(headers) = 'object'),
  ADD CONSTRAINT chk_nonprocessing_claim_clear CHECK (
    status = 'PROCESSING'
    OR (claim_token IS NULL AND lease_expires_at IS NULL)
  );

-- These names existed in older releases with narrower key definitions.
DROP INDEX IF EXISTS idx_outbox_pending;
DROP INDEX IF EXISTS idx_outbox_failed;

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_events (next_attempt_at ASC NULLS FIRST, created_at ASC)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_outbox_processing
  ON outbox_events (updated_at ASC)
  WHERE status = 'PROCESSING';

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_processing_claim_token
  ON outbox_events (claim_token)
  WHERE status = 'PROCESSING';

CREATE INDEX IF NOT EXISTS idx_outbox_processing_lease_expiry
  ON outbox_events (lease_expires_at ASC)
  WHERE status = 'PROCESSING';

CREATE INDEX IF NOT EXISTS idx_outbox_failed
  ON outbox_events (created_at DESC, id DESC)
  WHERE status = 'FAILED';

CREATE INDEX IF NOT EXISTS idx_outbox_admin_created
  ON outbox_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_outbox_tenant_admin
  ON outbox_events (tenant_id, created_at DESC, id DESC)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_tenant_status_admin
  ON outbox_events (tenant_id, status, created_at DESC, id DESC)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_tenant_processing
  ON outbox_events (tenant_id, updated_at ASC)
  WHERE status = 'PROCESSING' AND tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_sent_retention
  ON outbox_events (processed_at ASC, id ASC)
  WHERE status = 'SENT';

CREATE INDEX IF NOT EXISTS idx_outbox_tenant_sent_retention
  ON outbox_events (tenant_id, processed_at ASC, id ASC)
  WHERE status = 'SENT' AND tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_aggregate
  ON outbox_events (aggregate_type, aggregate_id, created_at ASC)
  WHERE aggregate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_tenant_pending
  ON outbox_events (tenant_id, created_at ASC)
  WHERE status = 'PENDING' AND tenant_id IS NOT NULL;
