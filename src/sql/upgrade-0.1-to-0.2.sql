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
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

UPDATE outbox_events
SET next_attempt_at = NOW()
WHERE status IN ('PENDING', 'PROCESSING')
  AND retry_count > 0
  AND next_attempt_at IS NULL;

DROP INDEX IF EXISTS idx_outbox_pending;

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_events (next_attempt_at ASC NULLS FIRST, created_at ASC)
  WHERE status = 'PENDING';

-- Aggregate lookup/replay support only; this is not a FIFO constraint.
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate
  ON outbox_events (aggregate_type, aggregate_id, created_at ASC)
  WHERE aggregate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_tenant_pending
  ON outbox_events (tenant_id, created_at ASC)
  WHERE status = 'PENDING' AND tenant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_processing_claim_token
  ON outbox_events (claim_token)
  WHERE status = 'PROCESSING';

CREATE INDEX IF NOT EXISTS idx_outbox_processing_lease_expiry
  ON outbox_events (lease_expires_at ASC)
  WHERE status = 'PROCESSING';
