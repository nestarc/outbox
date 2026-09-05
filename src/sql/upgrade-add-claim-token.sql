ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS claim_token UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_processing_claim_token
  ON outbox_events (claim_token)
  WHERE status = 'PROCESSING';
