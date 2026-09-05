export const OUTBOX_INVALID_CURSOR = 'OUTBOX_INVALID_CURSOR' as const;

/** Stable admin pagination error for malformed or unsupported cursors. */
export class OutboxCursorError extends Error {
  readonly code = OUTBOX_INVALID_CURSOR;

  constructor(message = 'Outbox cursor is malformed or unsupported') {
    super(message);
    this.name = 'OutboxCursorError';
  }
}
