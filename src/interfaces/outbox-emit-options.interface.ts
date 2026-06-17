import type { OutboxEvent } from '../outbox.event';

export interface OutboxEmitOptions {
  tenantId?: string | null;
  aggregateType?: string | null;
  aggregateId?: string | null;
  partitionKey?: string | null;
  idempotencyKey?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  headers?: Record<string, string>;
  occurredAt?: Date | null;
}

export type OutboxEmitManyEntry =
  | OutboxEvent
  | {
      event: OutboxEvent;
      options?: OutboxEmitOptions;
    };
