import type { OutboxRecord } from './outbox-record.interface';

export interface OutboxPublisher {
  publish(record: OutboxRecord): Promise<void>;
}
