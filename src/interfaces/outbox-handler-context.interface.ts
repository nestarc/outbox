import type { OutboxRecord } from './outbox-record.interface';

export interface OutboxHandlerContext {
  record: OutboxRecord;
  eventId: string;
  eventType: string;
  tenantId: string | null;
  retryCount: number;
  headers: Record<string, string>;
}
