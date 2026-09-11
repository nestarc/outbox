import 'reflect-metadata';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfirmationService } from './order-confirmation.listener';
import { OrderService } from './order.service';
import { PrismaService } from './prisma.module';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  // Required for Nest to invoke outbox shutdown hooks on SIGTERM/SIGINT.
  app.enableShutdownHooks();
  const prisma = app.get(PrismaService);
  try {
    const order = await app.get(OrderService).create(4200);
    const deadline = Date.now() + 10_000;
    let event: { id: string; status: string } | undefined;
    while (Date.now() < deadline) {
      [event] = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM outbox_events WHERE aggregate_id = ${order.id}
      `;
      assert.notEqual(
        event?.status,
        'FAILED',
        'Delivery failed; inspect last_error',
      );
      if (event?.status === 'SENT') break;
      await setTimeout(25);
    }
    assert.equal(
      event?.status,
      'SENT',
      'Timed out waiting for outbox delivery',
    );
    assert.ok(event);

    // Replay the same consumer operation to prove its persisted dedupe boundary.
    await app.get(ConfirmationService).recordOnce(order.id, event.id);
    const confirmations = await prisma.orderConfirmation.count({
      where: { eventId: event.id },
    });
    assert.equal(confirmations, 1);
    console.log(
      JSON.stringify(
        {
          orderId: order.id,
          eventId: event.id,
          status: event.status,
          confirmations,
          duplicateReplay: 'ignored',
        },
        null,
        2,
      ),
    );
  } finally {
    // Drain outbox callbacks before closing the application-owned Prisma pool.
    try {
      await app.close();
    } finally {
      await prisma.$disconnect();
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
