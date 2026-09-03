import type { OutboxRecord } from './outbox-record.interface';

export interface OutboxEmitContext {
  eventType: string;
  payload: Record<string, unknown>;
  tenantId: string | null;
  aggregateType: string | null;
  aggregateId: string | null;
  partitionKey: string | null;
  idempotencyKey: string | null;
  correlationId: string | null;
  causationId: string | null;
  headers: Record<string, string>;
  occurredAt: Date | null;
}

export interface OutboxPollContext {
  batchSize: number;
  deliveryMode: 'local' | 'publisher';
}

export interface OutboxDispatchContext {
  readonly record: OutboxRecord;
  readonly eventId: string;
  readonly eventType: string;
  readonly tenantId: string | null;
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly aggregateType: string | null;
  readonly aggregateId: string | null;
  readonly partitionKey: string | null;
  readonly idempotencyKey: string | null;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly headers: Readonly<Record<string, string>>;
}

export interface OutboxRetryContext extends OutboxDispatchContext {
  readonly error: Error;
  readonly retryCount: number;
  readonly maxRetries: number;
}

export interface OutboxHooks {
  onEmit?(context: OutboxEmitContext): void | Promise<void>;
  onPollStart?(context: OutboxPollContext): void | Promise<void>;
  onDispatchStart?(context: OutboxDispatchContext): void | Promise<void>;
  onDispatchSuccess?(
    context: OutboxDispatchContext & { readonly durationMs: number },
  ): void | Promise<void>;
  onDispatchFailure?(
    context: OutboxDispatchContext & {
      readonly error: Error;
      readonly durationMs: number;
    },
  ): void | Promise<void>;
  onRetryScheduled?(context: OutboxRetryContext): void | Promise<void>;
  onDeadLetter?(context: OutboxRetryContext): void | Promise<void>;
}
