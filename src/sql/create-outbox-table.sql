CREATE TABLE IF NOT EXISTS outbox_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    VARCHAR(255) NOT NULL,
  payload       JSONB NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  retry_count   INT NOT NULL DEFAULT 0,
  max_retries   INT NOT NULL DEFAULT 5,
  last_error    TEXT,
  tenant_id     VARCHAR(255),
  aggregate_type VARCHAR(255),
  aggregate_id   VARCHAR(255),
  partition_key  VARCHAR(255),
  idempotency_key VARCHAR(255),
  correlation_id VARCHAR(255),
  causation_id   VARCHAR(255),
  headers       JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claim_token   UUID,
  lease_expires_at TIMESTAMPTZ,

  CONSTRAINT chk_status CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED')),
  CONSTRAINT chk_retry_count_nonnegative CHECK (retry_count >= 0),
  CONSTRAINT chk_max_retries_positive CHECK (max_retries > 0),
  CONSTRAINT chk_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT chk_headers_object CHECK (jsonb_typeof(headers) = 'object'),
  CONSTRAINT chk_nonprocessing_claim_clear CHECK (
    status = 'PROCESSING'
    OR (claim_token IS NULL AND lease_expires_at IS NULL)
  )
);

-- PENDING eligibility lookup. created_at is a preference, not a FIFO guarantee;
-- concurrent claimers, retries, and equal timestamps can change delivery order.
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_events (next_attempt_at ASC NULLS FIRST, created_at ASC)
  WHERE status = 'PENDING';

-- PROCESSING events: stuck event recovery checks updated_at
CREATE INDEX IF NOT EXISTS idx_outbox_processing
  ON outbox_events (updated_at ASC)
  WHERE status = 'PROCESSING';

-- Active claim fencing: a token belongs to at most one PROCESSING row
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_processing_claim_token
  ON outbox_events (claim_token)
  WHERE status = 'PROCESSING';

-- Expired claims: lease recovery scans only PROCESSING rows
CREATE INDEX IF NOT EXISTS idx_outbox_processing_lease_expiry
  ON outbox_events (lease_expires_at ASC)
  WHERE status = 'PROCESSING';

-- FAILED events: admin/monitoring queries
CREATE INDEX IF NOT EXISTS idx_outbox_failed
  ON outbox_events (created_at DESC, id DESC)
  WHERE status = 'FAILED';

-- Deterministic operator traversal over the stable admin cursor tuple.
CREATE INDEX IF NOT EXISTS idx_outbox_admin_created
  ON outbox_events (created_at DESC, id DESC);

-- Tenant-scoped cursor traversal and exact per-status counts.
CREATE INDEX IF NOT EXISTS idx_outbox_tenant_admin
  ON outbox_events (tenant_id, created_at DESC, id DESC)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_tenant_status_admin
  ON outbox_events (tenant_id, status, created_at DESC, id DESC)
  WHERE tenant_id IS NOT NULL;

-- Tenant-scoped PROCESSING age checks use updated_at rather than created_at.
CREATE INDEX IF NOT EXISTS idx_outbox_tenant_processing
  ON outbox_events (tenant_id, updated_at ASC)
  WHERE status = 'PROCESSING' AND tenant_id IS NOT NULL;

-- SENT retention scans and bounded deletion candidates.
CREATE INDEX IF NOT EXISTS idx_outbox_sent_retention
  ON outbox_events (processed_at ASC, id ASC)
  WHERE status = 'SENT';

CREATE INDEX IF NOT EXISTS idx_outbox_tenant_sent_retention
  ON outbox_events (tenant_id, processed_at ASC, id ASC)
  WHERE status = 'SENT' AND tenant_id IS NOT NULL;

-- Aggregate lookup/replay support only. This index does not serialize claims
-- or guarantee aggregate, partition, or global FIFO.
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate
  ON outbox_events (aggregate_type, aggregate_id, created_at ASC)
  WHERE aggregate_id IS NOT NULL;

-- Tenant-aware polling/admin queries
CREATE INDEX IF NOT EXISTS idx_outbox_tenant_pending
  ON outbox_events (tenant_id, created_at ASC)
  WHERE status = 'PENDING' AND tenant_id IS NOT NULL;
