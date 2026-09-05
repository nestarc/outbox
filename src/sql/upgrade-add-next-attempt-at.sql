ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

-- Preserve retry eligibility for in-flight rows created by older runtimes.
UPDATE outbox_events
SET next_attempt_at = NOW()
WHERE status IN ('PENDING', 'PROCESSING')
  AND retry_count > 0
  AND next_attempt_at IS NULL;

-- Rebuild the existing index because CREATE INDEX IF NOT EXISTS does not
-- replace its pre-next_attempt_at definition.
DROP INDEX IF EXISTS idx_outbox_pending;

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_events (next_attempt_at ASC NULLS FIRST, created_at ASC)
  WHERE status = 'PENDING';
