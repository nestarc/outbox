import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { Injectable, type INestApplication } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { OutboxModule } from '../../src/outbox.module';
import { OutboxAdminService } from '../../src/outbox.admin.service';
import { OutboxEmitter } from '../../src/outbox.emitter';
import { OutboxEvent } from '../../src/outbox.event';
import { OnOutboxEvent } from '../../src/outbox.decorator';
import type { OutboxHandlerContext } from '../../src/interfaces/outbox-handler-context.interface';

// --- Test event ---
class OrderCreatedEvent extends OutboxEvent {
  static readonly eventType = 'order.created';
  constructor(
    public readonly orderId: string,
    public readonly total: number,
  ) {
    super();
  }
}

// --- Test listener ---
@Injectable()
class TestListener {
  readonly received: Record<string, unknown>[] = [];
  readonly contexts: OutboxHandlerContext[] = [];

  @OnOutboxEvent(OrderCreatedEvent)
  async handleOrderCreated(
    payload: Record<string, unknown>,
    context: OutboxHandlerContext,
  ) {
    this.received.push(payload);
    this.contexts.push(context);
  }
}

// --- Failing listener ---
@Injectable()
class FailingListener {
  callCount = 0;

  @OnOutboxEvent(OrderCreatedEvent)
  async handleOrderCreated() {
    this.callCount++;
    if (this.callCount <= 2) {
      throw new Error(`Fail attempt ${this.callCount}`);
    }
  }
}

// --- Admin retry listener ---
@Injectable()
class ToggleFailingListener {
  callCount = 0;
  shouldFail = true;

  @OnOutboxEvent(OrderCreatedEvent)
  async handleOrderCreated() {
    this.callCount++;
    if (this.shouldFail) {
      throw new Error('blocked by test');
    }
  }
}

const MIGRATION_SQL_FILE = fs.readFileSync(
  path.join(__dirname, '../../src/sql/create-outbox-table.sql'),
  'utf-8',
);

// Split multi-statement SQL for Prisma's $executeRawUnsafe (single statement only).
// Remove full-line comments first so a comment cannot hide the following statement.
const MIGRATION_STATEMENTS = MIGRATION_SQL_FILE.replace(/^\s*--.*$/gm, '')
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Outbox E2E', () => {
  let prisma: any;

  beforeAll(async () => {
    const connectionString =
      process.env.DATABASE_URL ??
      'postgresql://test:test@localhost:5433/outbox_test';
    const prismaVersion = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), 'node_modules', '@prisma', 'client', 'package.json'),
        'utf8',
      ),
    ).version as string;

    if (Number(prismaVersion.split('.')[0]) >= 7) {
      const { PrismaClient } = await import(
        path.join(__dirname, 'generated', 'client')
      );
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString }),
      });
    } else {
      process.env.DATABASE_URL = connectionString;
      const LegacyPrismaClient = (await import('@prisma/client'))
        .PrismaClient as unknown as new () => any;
      prisma = new LegacyPrismaClient();
    }
    await prisma.$connect();
    for (const stmt of MIGRATION_STATEMENTS) {
      await prisma.$executeRawUnsafe(stmt);
    }
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS outbox_events');
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE outbox_events');
  });

  it('should apply the complete table and index migration', async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname::text AS indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'outbox_events'
    `;

    expect(
      indexes
        .map((row: { indexname: string }) => row.indexname)
        .sort(),
    ).toEqual(
      expect.arrayContaining([
        'idx_outbox_aggregate',
        'idx_outbox_failed',
        'idx_outbox_pending',
        'idx_outbox_processing',
        'idx_outbox_tenant_pending',
        'outbox_events_pkey',
      ]),
    );
  });

  describe('basic flow', () => {
    let app: INestApplication;
    let emitter: OutboxEmitter;
    let listener: TestListener;

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRoot({
            prisma,
            polling: { enabled: true, interval: 500, batchSize: 10 },
            retry: { maxRetries: 3, backoff: 'fixed', initialDelay: 500 },
          }),
        ],
        providers: [TestListener],
      }).compile();

      app = module.createNestApplication();
      await app.init();

      emitter = module.get(OutboxEmitter);
      listener = module.get(TestListener);
    });

    afterAll(async () => {
      await app.close();
    });

    it('should emit event in transaction and deliver via poller', async () => {
      await prisma.$transaction(async (tx: any) => {
        await emitter.emit(tx, new OrderCreatedEvent('order-1', 99.99), {
          tenantId: 'tenant-1',
          aggregateType: 'Order',
          aggregateId: 'order-1',
          partitionKey: 'order-1',
          idempotencyKey: 'idem-1',
          correlationId: 'corr-1',
          causationId: 'cause-1',
          headers: { source: 'e2e' },
          occurredAt: new Date('2026-01-02T03:04:05.000Z'),
        });
      });

      // Verify PENDING record exists
      const pending = await prisma.$queryRaw<any[]>`
        SELECT * FROM outbox_events WHERE event_type = 'order.created'
      `;
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe('PENDING');
      expect(pending[0].tenant_id).toBe('tenant-1');
      expect(pending[0].aggregate_type).toBe('Order');
      expect(pending[0].aggregate_id).toBe('order-1');
      expect(pending[0].partition_key).toBe('order-1');
      expect(pending[0].idempotency_key).toBe('idem-1');
      expect(pending[0].correlation_id).toBe('corr-1');
      expect(pending[0].causation_id).toBe('cause-1');
      expect(pending[0].headers).toEqual({ source: 'e2e' });

      // Wait for poller to process
      await sleep(2000);

      // Verify handler was called
      expect(listener.received).toHaveLength(1);
      expect(listener.received[0]).toEqual({
        orderId: 'order-1',
        total: 99.99,
      });
      expect(listener.contexts[0]).toEqual(
        expect.objectContaining({
          eventId: pending[0].id,
          eventType: 'order.created',
          tenantId: 'tenant-1',
          headers: { source: 'e2e' },
        }),
      );

      // Verify status is SENT
      const sent = await prisma.$queryRaw<any[]>`
        SELECT * FROM outbox_events WHERE id = ${pending[0].id}::uuid
      `;
      expect(sent[0].status).toBe('SENT');
      expect(sent[0].processed_at).not.toBeNull();
    });

    it('should rollback outbox event when transaction fails', async () => {
      await expect(
        prisma.$transaction(async (tx: any) => {
          await emitter.emit(tx, new OrderCreatedEvent('order-2', 50));
          throw new Error('Business logic failed');
        }),
      ).rejects.toThrow('Business logic failed');

      const records = await prisma.$queryRaw<any[]>`
        SELECT * FROM outbox_events WHERE event_type = 'order.created'
      `;
      expect(records).toHaveLength(0);
    });

    it('should emit multiple events with emitMany', async () => {
      await prisma.$transaction(async (tx: any) => {
        await emitter.emitMany(tx, [
          new OrderCreatedEvent('order-3', 10),
          new OrderCreatedEvent('order-4', 20),
        ]);
      });

      const records = await prisma.$queryRaw<any[]>`
        SELECT * FROM outbox_events ORDER BY created_at
      `;
      expect(records).toHaveLength(2);
    });
  });

  describe('retry flow', () => {
    let app: INestApplication;
    let emitter: OutboxEmitter;
    let failingListener: FailingListener;

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRoot({
            prisma,
            polling: { enabled: true, interval: 500, batchSize: 10 },
            retry: { maxRetries: 5, backoff: 'fixed', initialDelay: 100 },
          }),
        ],
        providers: [FailingListener],
      }).compile();

      app = module.createNestApplication();
      await app.init();

      emitter = module.get(OutboxEmitter);
      failingListener = module.get(FailingListener);
    });

    afterAll(async () => {
      await app.close();
    });

    it('should retry failed events and eventually succeed', async () => {
      await prisma.$transaction(async (tx: any) => {
        await emitter.emit(tx, new OrderCreatedEvent('order-retry', 100));
      });

      // Wait for multiple poll cycles (fail, fail, succeed)
      await sleep(4000);

      expect(failingListener.callCount).toBeGreaterThanOrEqual(3);

      const records = await prisma.$queryRaw<any[]>`
        SELECT * FROM outbox_events WHERE event_type = 'order.created'
      `;
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe('SENT');
    });
  });

  describe('admin retry flow', () => {
    let app: INestApplication;
    let emitter: OutboxEmitter;
    let admin: OutboxAdminService;
    let toggleListener: ToggleFailingListener;

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRoot({
            prisma,
            polling: { enabled: true, interval: 200, batchSize: 10 },
            retry: { maxRetries: 1, backoff: 'fixed', initialDelay: 50 },
          }),
        ],
        providers: [ToggleFailingListener],
      }).compile();

      app = module.createNestApplication();
      await app.init();

      emitter = module.get(OutboxEmitter);
      admin = module.get(OutboxAdminService);
      toggleListener = module.get(ToggleFailingListener);
    });

    afterAll(async () => {
      await app.close();
    });

    it('should retry a failed event through OutboxAdminService', async () => {
      await prisma.$transaction(async (tx: any) => {
        await emitter.emit(tx, new OrderCreatedEvent('order-admin', 42));
      });

      await sleep(1000);

      const failed = await prisma.$queryRaw<any[]>`
        SELECT * FROM outbox_events WHERE event_type = 'order.created'
      `;
      expect(failed).toHaveLength(1);
      expect(failed[0].status).toBe('FAILED');

      const stats = await admin.getStats();
      expect(stats.failed).toBe(1);

      const listed = await admin.list({ status: 'FAILED' });
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe(failed[0].id);

      toggleListener.shouldFail = false;
      await expect(admin.retry(failed[0].id)).resolves.toBe(true);

      await sleep(1000);

      const sent = await prisma.$queryRaw<any[]>`
        SELECT * FROM outbox_events WHERE id = ${failed[0].id}::uuid
      `;
      expect(sent[0].status).toBe('SENT');
      expect(toggleListener.callCount).toBeGreaterThanOrEqual(2);
    });
  });
});
