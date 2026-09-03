export interface OutboxRecord {
  readonly id: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED';
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly processedAt: Date | null;
  readonly nextAttemptAt: Date | null;
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly lastError: string | null;
  readonly tenantId: string | null;
  readonly aggregateType: string | null;
  readonly aggregateId: string | null;
  readonly partitionKey: string | null;
  readonly idempotencyKey: string | null;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly occurredAt: Date;
}
