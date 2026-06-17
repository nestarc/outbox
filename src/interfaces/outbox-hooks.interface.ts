import type { OutboxEmitOptions } from './outbox-emit-options.interface';
import type { OutboxRecord } from './outbox-record.interface';

export interface OutboxEmitContext extends Required<OutboxEmitOptions> {
  eventType: string;
  payload: Record<string, unknown>;
}

export interface OutboxPollContext {
  batchSize: number;
  deliveryMode: 'local' | 'publisher';
}

export interface OutboxDispatchContext {
  record: OutboxRecord;
  eventId: string;
  eventType: string;
  tenantId: string | null;
  retryCount: number;
  maxRetries: number;
  aggregateType: string | null;
  aggregateId: string | null;
  partitionKey: string | null;
  idempotencyKey: string | null;
  correlationId: string | null;
  causationId: string | null;
  headers: Record<string, string>;
}

export interface OutboxRetryContext extends OutboxDispatchContext {
  error: Error;
  retryCount: number;
  maxRetries: number;
}

export interface OutboxHooks {
  onEmit?(context: OutboxEmitContext): void | Promise<void>;
  onPollStart?(context: OutboxPollContext): void | Promise<void>;
  onDispatchStart?(context: OutboxDispatchContext): void | Promise<void>;
  onDispatchSuccess?(
    context: OutboxDispatchContext & { durationMs: number },
  ): void | Promise<void>;
  onDispatchFailure?(
    context: OutboxDispatchContext & {
      error: Error;
      durationMs: number;
    },
  ): void | Promise<void>;
  onRetryScheduled?(context: OutboxRetryContext): void | Promise<void>;
  onDeadLetter?(context: OutboxRetryContext): void | Promise<void>;
}
