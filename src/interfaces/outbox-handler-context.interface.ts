import type { OutboxRecord } from './outbox-record.interface';

export interface OutboxHandlerContext {
  readonly record: OutboxRecord;
  readonly eventId: string;
  readonly eventType: string;
  readonly tenantId: string | null;
  readonly retryCount: number;
  readonly headers: Readonly<Record<string, string>>;
}
