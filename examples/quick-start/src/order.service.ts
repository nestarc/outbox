import { Injectable } from '@nestjs/common';
import { OutboxEmitter } from '@nestarc/outbox';
import { OrderCreatedEvent } from './order-created.event';
import { PrismaService } from './prisma.module';

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxEmitter,
  ) {}

  create(total: number) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({ data: { total } });
      await this.outbox.emit(tx, new OrderCreatedEvent(order.id, order.total), {
        aggregateType: 'Order',
        aggregateId: order.id,
      });
      return order;
    });
  }
}
