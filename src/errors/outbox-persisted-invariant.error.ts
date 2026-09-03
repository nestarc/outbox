export const OUTBOX_PERSISTED_INVARIANT_VIOLATION =
  'OUTBOX_PERSISTED_INVARIANT_VIOLATION';

export class OutboxPersistedInvariantError extends Error {
  readonly code = OUTBOX_PERSISTED_INVARIANT_VIOLATION;

  constructor(
    readonly eventId: string | null,
    readonly field: string,
    message: string,
  ) {
    const identity = eventId ? ` for event ${eventId}` : '';
    super(
      `Outbox persisted invariant violation${identity}: ${field} ${message}`,
    );
    this.name = 'OutboxPersistedInvariantError';
  }
}
