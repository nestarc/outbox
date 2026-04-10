import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_MAX_RETRIES,
  OUTBOX_OPTIONS,
} from './outbox.constants';
import type { OutboxOptions } from './interfaces/outbox-options.interface';
import type { PrismaTransactionClient } from './interfaces/prisma-transaction-client.interface';
import type { OutboxEvent } from './outbox.event';

@Injectable()
export class OutboxEmitter {
  private readonly maxRetries: number;

  constructor(@Inject(OUTBOX_OPTIONS) options: OutboxOptions) {
    this.maxRetries = options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async emit(
    tx: PrismaTransactionClient,
    event: OutboxEvent,
  ): Promise<void> {
    const eventType = event.getEventType();
    const payload = JSON.stringify(event.toPayload());

    await tx.$executeRaw`
      INSERT INTO outbox_events (event_type, payload, max_retries)
      VALUES (${eventType}, ${payload}::jsonb, ${this.maxRetries})
    `;
  }

  async emitMany(
    tx: PrismaTransactionClient,
    events: OutboxEvent[],
  ): Promise<void> {
    for (const event of events) {
      await this.emit(tx, event);
    }
  }
}
