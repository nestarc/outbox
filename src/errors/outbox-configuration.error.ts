export const OUTBOX_INVALID_CONFIGURATION = 'OUTBOX_INVALID_CONFIGURATION';

export class OutboxConfigurationError extends Error {
  readonly code = OUTBOX_INVALID_CONFIGURATION;

  constructor(
    readonly option: string,
    message: string,
  ) {
    super(`Outbox ${option} ${message}`);
    this.name = 'OutboxConfigurationError';
  }
}
