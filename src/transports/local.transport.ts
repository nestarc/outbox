import { Injectable } from '@nestjs/common';
import type { OutboxHandler } from '../interfaces/outbox-handler.interface';
import type { OutboxRecord } from '../interfaces/outbox-record.interface';
import type { OutboxTransport } from '../interfaces/outbox-transport.interface';

@Injectable()
export class LocalTransport implements OutboxTransport {
  async dispatch(
    record: OutboxRecord,
    handlers: OutboxHandler[],
  ): Promise<void> {
    for (const handler of handlers) {
      await handler.instance[handler.methodName](record.payload);
    }
  }
}
