import type { OutboxHandler } from './outbox-handler.interface';
import type { OutboxHandlerContext } from './outbox-handler-context.interface';
import type { OutboxRecord } from './outbox-record.interface';

export interface OutboxTransport {
  dispatch(
    record: OutboxRecord,
    handlers: OutboxHandler[],
    context?: OutboxHandlerContext,
  ): Promise<void>;
}
