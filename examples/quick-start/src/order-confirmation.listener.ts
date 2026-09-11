import { Injectable } from '@nestjs/common';
import { OnOutboxEvent, type OutboxHandlerContext } from '@nestarc/outbox';
import { OrderCreatedEvent } from './order-created.event';
import { PrismaService } from './prisma.module';

@Injectable()
export class ConfirmationService {
  constructor(private readonly prisma: PrismaService) {}

  async recordOnce(orderId: string, eventId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.processedEvent.createMany({
        data: { eventId },
        skipDuplicates: true,
      });
      if (claimed.count === 0) return;

      // The receipt and this database side effect commit or roll back together.
      // An external email call cannot join this transaction. For real email,
      // use the provider's durable idempotency mechanism with the same event ID.
      await tx.orderConfirmation.create({ data: { orderId, eventId } });
    });
  }
}

@Injectable()
export class OrderConfirmationListener {
  constructor(private readonly confirmations: ConfirmationService) {}

  @OnOutboxEvent(OrderCreatedEvent)
  async handle(
    payload: { orderId: string; total: number },
    context: OutboxHandlerContext,
  ): Promise<void> {
    await this.confirmations.recordOnce(payload.orderId, context.eventId);
  }
}
