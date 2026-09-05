import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  Global,
  Injectable,
  Module,
  type FactoryProvider,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  OnOutboxEvent,
  OutboxEmitter,
  OutboxWakeupUnavailableError,
  OUTBOX_OPTIONS,
  type OutboxOptions,
  type OutboxHandlerContext,
} from '@nestarc/outbox';
import { AppModule } from './local';
import { OrderCreatedEvent } from './event';
import { OrderService } from './emit';
import { registration as publisherRegistration } from './async';
import { registration as tenantRegistration } from './tenant';
import { registration as wakeupRegistration } from './wakeup';
import {
  PrismaModule,
  PrismaService,
  EmailService,
  KafkaProducer,
  TenantContext,
  TenantContextModule,
} from './support';

@Injectable()
class TenantListener {
  readonly seen: Array<{ tenant: string | undefined; eventId: string }> = [];
  constructor(private readonly context: TenantContext) {}
  @OnOutboxEvent(OrderCreatedEvent)
  async handle(
    _payload: unknown,
    context: OutboxHandlerContext,
  ): Promise<void> {
    this.seen.push({
      tenant: this.context.storage.getStore(),
      eventId: context.eventId,
    });
  }
}

// forRoot has no imports option: injected provider dependencies must be global.
@Global()
@Module({ imports: [TenantContextModule], exports: [TenantContextModule] })
class GlobalTenantModule {}

async function waitForSent(prisma: PrismaService, id: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM outbox_events WHERE id = ${id}::uuid
    `;
    if (row?.status === 'SENT') return;
    assert.notEqual(row?.status, 'FAILED', `event ${id} failed`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for SENT: ${id}`);
}

async function eventId(
  prisma: PrismaService,
  orderId: string,
): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ id: string; tenant_id: string }>>`
    SELECT id, tenant_id FROM outbox_events WHERE payload ->> 'orderId' = ${orderId}
  `;
  assert.equal(rows.length, 1);
  return rows[0].id;
}

async function withModule(
  moduleRef: TestingModule,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await moduleRef.init();
    await run();
  } finally {
    await moduleRef.close();
    await moduleRef.get(PrismaService).$disconnect();
  }
}

async function main(): Promise<void> {
  const withPg = process.env.OUTBOX_EXAMPLES_WITH_PG === 'true';
  // Resolve from the installed package itself so workspace/global modules cannot
  // accidentally make the absent optional dependency case pass.
  const packageRequire = createRequire(require.resolve('@nestarc/outbox'));
  if (withPg) assert.ok(packageRequire.resolve('pg'));
  else
    assert.throws(() => packageRequire.resolve('pg'), {
      code: 'MODULE_NOT_FOUND',
    });

  const db = new PrismaService();
  try {
    await db.$executeRawUnsafe(`CREATE TABLE packed_example_orders (
      id uuid PRIMARY KEY, total integer NOT NULL, "tenantId" text NOT NULL, "requestId" text NOT NULL
    )`);
    const local = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await withModule(local, async () => {
      const prisma = local.get(PrismaService);
      const order = await local.get(OrderService).createOrder({
        total: 42,
        tenantId: 'tenant-local',
        requestId: 'local-request',
      });
      const id = await eventId(prisma, order.id);
      await waitForSent(prisma, id);
      assert.deepEqual(local.get(EmailService).confirmations, [order.id]);
      const [row] = await prisma.$queryRaw<
        Array<{ tenant_id: string; aggregate_id: string; headers: unknown }>
      >`
        SELECT tenant_id, aggregate_id, headers FROM outbox_events WHERE id = ${id}::uuid
      `;
      assert.equal(row.tenant_id, 'tenant-local');
      assert.equal(row.aggregate_id, order.id);
      assert.deepEqual(row.headers, { source: 'orders-api' });
      await assert.rejects(
        prisma.$transaction(async (tx) => {
          const rollback = await tx.order.create({
            data: { total: 1, tenantId: 'tenant-local', requestId: 'rollback' },
          });
          await local
            .get(OutboxEmitter)
            .emit(tx, new OrderCreatedEvent(rollback.id, 1));
          throw new Error('rollback-example');
        }),
        /rollback-example/,
      );
      assert.equal(await prisma.order.count(), 1);
      const [count] = await prisma.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*) FROM outbox_events`;
      assert.equal(Number(count.count), 1);
    });
    console.log(
      '[packed-examples] local registration/handler/transaction/rollback PASS',
    );

    const publisher = await Test.createTestingModule({
      imports: [publisherRegistration],
    }).compile();
    await withModule(publisher, async () => {
      const prisma = publisher.get(PrismaService);
      const tenant = publisher.get(TenantContext);
      await tenant.storage.run('tenant-publisher', () =>
        prisma.$transaction((tx) =>
          publisher
            .get(OutboxEmitter)
            .emit(tx, new OrderCreatedEvent('published-order', 7), {
              partitionKey: 'order-key',
              headers: { source: 'example' },
            }),
        ),
      );
      const id = await eventId(prisma, 'published-order');
      await waitForSent(prisma, id);
      assert.deepEqual(
        publisher.get(KafkaProducer).sent.map((record) => ({
          ...record,
          messages: record.messages.map((message) => ({
            ...message,
            value: JSON.parse(message.value) as unknown,
          })),
        })),
        [
          {
            topic: 'order.created',
            messages: [
              {
                key: 'order-key',
                value: { orderId: 'published-order', total: 7 },
                headers: { source: 'example' },
              },
            ],
          },
        ],
      );
      assert.equal(tenant.storage.getStore(), undefined);
    });
    console.log(
      '[packed-examples] async factory/transport/tenant constructor DI/publisher without handlers PASS',
    );

    const tenantModule = await Test.createTestingModule({
      imports: [PrismaModule, GlobalTenantModule, tenantRegistration],
      providers: [TenantListener],
    }).compile();
    await withModule(tenantModule, async () => {
      const prisma = tenantModule.get(PrismaService);
      const tenant = tenantModule.get(TenantContext);
      const emitter = tenantModule.get(OutboxEmitter);
      await tenant.storage.run('tenant-restored', () =>
        prisma.$transaction((tx) =>
          emitter.emit(tx, new OrderCreatedEvent('tenant-order', 9)),
        ),
      );
      const id = await eventId(prisma, 'tenant-order');
      await waitForSent(prisma, id);
      assert.deepEqual(tenantModule.get(TenantListener).seen, [
        { tenant: 'tenant-restored', eventId: id },
      ]);
      assert.equal(tenant.storage.getStore(), undefined);
      await assert.rejects(
        tenant.storage.run('tenant-restored', () =>
          prisma.$transaction((tx) =>
            emitter.emit(tx, new OrderCreatedEvent('mismatch', 1), {
              tenantId: 'another-tenant',
            }),
          ),
        ),
      );
      const [count] = await prisma.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*) FROM outbox_events WHERE payload ->> 'orderId' = 'mismatch'`;
      assert.equal(Number(count.count), 0);
    });
    console.log(
      '[packed-examples] require-match/tenant context restoration/rejection before insert PASS',
    );

    const optionsProvider = wakeupRegistration.providers?.find(
      (provider): provider is FactoryProvider =>
        typeof provider === 'object' &&
        'provide' in provider &&
        provider.provide === OUTBOX_OPTIONS &&
        'useFactory' in provider,
    );
    assert.ok(optionsProvider);
    const wakeup = await Test.createTestingModule({
      imports: [PrismaModule, wakeupRegistration],
      providers: [TenantListener, TenantContext],
    })
      .overrideProvider(OUTBOX_OPTIONS)
      .useFactory({
        inject: optionsProvider.inject,
        factory: (...args: unknown[]): OutboxOptions => {
          const options = optionsProvider.useFactory(...args) as OutboxOptions;
          return {
            ...options,
            polling: { ...options.polling, enabled: false },
          };
        },
      })
      .compile();
    // Disable polling before the poller constructor reads its options. Keep
    // the README's default pg loader and connection/channel configuration.
    if (withPg) {
      await withModule(wakeup, async () => {
        const prisma = wakeup.get(PrismaService);
        await prisma.$transaction((tx) =>
          wakeup
            .get(OutboxEmitter)
            .emit(tx, new OrderCreatedEvent('notified-order', 11)),
        );
        const id = await eventId(prisma, 'notified-order');
        // init() is the LISTEN readiness barrier; NOTIFY happens after commit.
        await prisma.$queryRaw`SELECT pg_notify('outbox_events', '')::text`;
        await waitForSent(prisma, id);
        assert.equal(wakeup.get(TenantListener).seen.length, 1);
      });
    } else {
      try {
        await assert.rejects(wakeup.init(), OutboxWakeupUnavailableError);
      } finally {
        try {
          // Nest close() awaits the rejected initialization promise before
          // shutdown hooks. No timer/client was started in this absent lane.
          await wakeup.close().catch((error: unknown) => {
            if (!(error instanceof OutboxWakeupUnavailableError)) throw error;
          });
        } finally {
          await wakeup.get(PrismaService).$disconnect();
        }
      }
    }
    console.log(
      `[packed-examples] optional pg ${withPg ? 'LISTEN/NOTIFY delivery' : 'typed missing-peer startup failure'} PASS`,
    );
  } finally {
    await db.$executeRawUnsafe('DROP TABLE IF EXISTS packed_example_orders');
    await db.$executeRawUnsafe('DROP TABLE IF EXISTS outbox_events');
    await db.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
