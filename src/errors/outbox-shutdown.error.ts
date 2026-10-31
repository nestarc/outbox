export const OUTBOX_SHUTDOWN_INCOMPLETE = 'OUTBOX_SHUTDOWN_INCOMPLETE' as const;

/** The deadline expired; callbacks and their backing resources still belong to the worker. */
export class OutboxShutdownError extends Error {
  readonly name = 'OutboxShutdownError';
  readonly code = OUTBOX_SHUTDOWN_INCOMPLETE;

  constructor(
    readonly timeoutMs: number,
    readonly pollsInFlight: number,
    readonly eventsInFlight: number,
  ) {
    super(
      `Outbox did not drain within ${timeoutMs}ms: ` +
        `${pollsInFlight} polls, ${eventsInFlight} events still in flight`,
    );
  }
}
