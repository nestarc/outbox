export const OUTBOX_INVALID_ENVELOPE = 'OUTBOX_INVALID_ENVELOPE' as const;

export type OutboxEnvelopeErrorReason =
  | 'invalid_type'
  | 'empty'
  | 'too_long'
  | 'invalid_date'
  | 'unsupported_json_value'
  | 'circular'
  | 'too_deep'
  | 'too_large';

/** Stable producer-side validation error thrown before any database call. */
export class OutboxEnvelopeError extends Error {
  readonly code = OUTBOX_INVALID_ENVELOPE;

  constructor(
    readonly field: string,
    readonly reason: OutboxEnvelopeErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'OutboxEnvelopeError';
  }
}
