-- Re-adding in one ALTER keeps this upgrade idempotent and validates existing
-- rows before the new runtime starts dispatching them.
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
