export const OUTBOX_WAKEUP_UNAVAILABLE = 'OUTBOX_WAKEUP_UNAVAILABLE' as const;

/**
 * Raised during module initialization when both the polling scheduler and the
 * PostgreSQL wakeup transport are unavailable.
 */
export class OutboxWakeupUnavailableError extends Error {
  readonly code = OUTBOX_WAKEUP_UNAVAILABLE;

  constructor(cause: Error) {
    super(
      `Outbox wakeup is unavailable while polling is disabled: ${cause.message}`,
      { cause },
    );
    this.name = 'OutboxWakeupUnavailableError';
  }
}
