export const OUTBOX_SCHEMA_MISMATCH = 'OUTBOX_SCHEMA_MISMATCH' as const;

export class OutboxSchemaError extends Error {
  readonly name = 'OutboxSchemaError';
  readonly code = OUTBOX_SCHEMA_MISMATCH;

  constructor(
    readonly requiredVersion: string,
    readonly actualVersion: string,
    readonly missing: readonly string[],
  ) {
    super(
      `Outbox schema ${actualVersion} is incompatible with required ${requiredVersion}; ` +
        `apply src/sql/upgrade-to-current.sql (missing: ${missing.join(', ')})`,
    );
  }
}
