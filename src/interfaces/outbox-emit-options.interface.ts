import type { OutboxEvent } from '../outbox.event';

interface OutboxEmitMetadata {
  aggregateType?: string | null;
  aggregateId?: string | null;
  partitionKey?: string | null;
  idempotencyKey?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  headers?: Record<string, string>;
  occurredAt?: Date | null;
}

export type OutboxEmitOptions = OutboxEmitMetadata &
  (
    | {
        /** Explicit producer tenant. `undefined` falls back to the provider. */
        tenantId?: string;
        tenantScope?: never;
      }
    | {
        /** Deliberate escape hatch for an event that belongs to no tenant. */
        tenantScope: 'global';
        tenantId?: never;
      }
  );

export type OutboxEmitManyEntry =
  | OutboxEvent
  | {
      event: OutboxEvent;
      options?: OutboxEmitOptions;
    };
