import { Test } from '@nestjs/testing';
import { Injectable, type INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { OutboxModule } from '../../src/outbox.module';
import { OutboxEmitter } from '../../src/outbox.emitter';
import { OutboxEvent } from '../../src/outbox.event';
import { OnOutboxEvent } from '../../src/outbox.decorator';

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

// --- Test PrismaService ---
@Injectable()
class PrismaService extends PrismaClient {
  constructor() {
    super({
      datasources: {
        db: {
          url:
            process.env.DATABASE_URL ??
            'postgresql://test:test@localhost:5433/outbox_test',
        },
      },
    });
  }
}

// --- Test listener ---
@Injectable()
class TestListener {
  readonly received: Record<string, unknown>[] = [];

  @OnOutboxEvent(OrderCreatedEvent)
  async handleOrderCreated(payload: Record<string, unknown>) {
    this.received.push(payload);
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

const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS outbox_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type    VARCHAR(255) NOT NULL,
    payload       JSONB NOT NULL,
    status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at  TIMESTAMPTZ,
    retry_count   INT NOT NULL DEFAULT 0,
    max_retries   INT NOT NULL DEFAULT 5,
    last_error    TEXT,
    tenant_id     VARCHAR(255),
    CONSTRAINT chk_status CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED'))
  );
`;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Outbox E2E', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.$executeRawUnsafe(MIGRATION_SQL);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS outbox_events');
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE outbox_events');
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
        await emitter.emit(tx, new OrderCreatedEvent('order-1', 99.99));
      });

      // Verify PENDING record exists
      const pending = await prisma.$queryRaw<any[]>`
        SELECT * FROM outbox_events WHERE event_type = 'order.created'
      `;
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe('PENDING');

      // Wait for poller to process
      await sleep(2000);

      // Verify handler was called
      expect(listener.received).toHaveLength(1);
      expect(listener.received[0]).toEqual({
        orderId: 'order-1',
        total: 99.99,
      });

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
});
