import type { OutboxHandler } from './outbox-handler.interface';
import type { OutboxRecord } from './outbox-record.interface';

export interface OutboxTransport {
  dispatch(record: OutboxRecord, handlers: OutboxHandler[]): Promise<void>;
}
