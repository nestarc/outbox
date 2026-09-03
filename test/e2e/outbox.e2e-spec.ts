import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { Injectable, type INestApplication } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { OutboxModule } from '../../src/outbox.module';
import { OutboxAdminService } from '../../src/outbox.admin.service';
import { OutboxEmitter } from '../../src/outbox.emitter';
import { OutboxEvent } from '../../src/outbox.event';
import { OutboxListener } from '../../src/outbox.listener';
import { OutboxPoller } from '../../src/outbox.poller';
import { OnOutboxEvent } from '../../src/outbox.decorator';
import type { OutboxHandlerContext } from '../../src/interfaces/outbox-handler-context.interface';
import type { OutboxNotificationClient } from '../../src/interfaces/outbox-wakeup.interface';
import type { OutboxRecord } from '../../src/interfaces/outbox-record.interface';

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

const CLAIM_TOKEN_UPGRADE_SQL_FILE = fs.readFileSync(
  path.join(__dirname, '../../src/sql/upgrade-add-claim-token.sql'),
  'utf-8',
);
const CLAIM_TOKEN_UPGRADE_STATEMENTS = CLAIM_TOKEN_UPGRADE_SQL_FILE.replace(
  /^\s*--.*$/gm,
  '',
)
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const LEASE_UPGRADE_SQL_FILE = fs.readFileSync(
  path.join(__dirname, '../../src/sql/upgrade-add-lease.sql'),
  'utf-8',
);
const LEASE_UPGRADE_STATEMENTS = LEASE_UPGRADE_SQL_FILE.replace(
  /^\s*--.*$/gm,
  '',
)
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const NEXT_ATTEMPT_UPGRADE_SQL_FILE = fs.readFileSync(
  path.join(__dirname, '../../src/sql/upgrade-add-next-attempt-at.sql'),
  'utf-8',
);
const NEXT_ATTEMPT_UPGRADE_STATEMENTS = NEXT_ATTEMPT_UPGRADE_SQL_FILE.replace(
  /^\s*--.*$/gm,
  '',
)
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
        path.join(
          process.cwd(),
          'node_modules',
          '@prisma',
          'client',
          'package.json',
        ),
        'utf8',
      ),
    ).version as string;
    const prismaMajor = Number(prismaVersion.split('.')[0]);

    if (prismaMajor >= 7) {
      const { PrismaClient } = await import(
        path.join(__dirname, 'generated', 'client')
      );
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString }),
      });
    } else {
      process.env.DATABASE_URL = connectionString;
      const { PrismaClient: LegacyPrismaClient } =
        (await import('@prisma/client')) as unknown as {
          PrismaClient: new () => any;
        };
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
      indexes.map((row: { indexname: string }) => row.indexname).sort(),
    ).toEqual(
      expect.arrayContaining([
        'idx_outbox_aggregate',
        'idx_outbox_failed',
        'idx_outbox_pending',
        'idx_outbox_processing',
        'idx_outbox_processing_claim_token',
        'idx_outbox_processing_lease_expiry',
        'idx_outbox_tenant_pending',
        'outbox_events_pkey',
      ]),
    );
  });

  it('upgrades a current table with the claim token fence idempotently', async () => {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE outbox_events DROP COLUMN claim_token',
    );

    for (const statement of CLAIM_TOKEN_UPGRADE_STATEMENTS) {
      await prisma.$executeRawUnsafe(statement);
      await prisma.$executeRawUnsafe(statement);
    }

    const columns = await prisma.$queryRaw<Array<{ dataType: string }>>`
      SELECT data_type::text AS "dataType"
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'outbox_events'
        AND column_name = 'claim_token'
    `;
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname::text AS indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'outbox_events'
        AND indexname = 'idx_outbox_processing_claim_token'
    `;

    expect(columns).toEqual([{ dataType: 'uuid' }]);
    expect(indexes).toHaveLength(1);
  });

  it('upgrades a current table with lease recovery idempotently', async () => {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE outbox_events DROP COLUMN lease_expires_at',
    );

    for (const statement of LEASE_UPGRADE_STATEMENTS) {
      await prisma.$executeRawUnsafe(statement);
      await prisma.$executeRawUnsafe(statement);
    }

    const columns = await prisma.$queryRaw<Array<{ dataType: string }>>`
      SELECT data_type::text AS "dataType"
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'outbox_events'
        AND column_name = 'lease_expires_at'
    `;
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname::text AS indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'outbox_events'
        AND indexname = 'idx_outbox_processing_lease_expiry'
    `;

    expect(columns).toEqual([{ dataType: 'timestamp with time zone' }]);
    expect(indexes).toHaveLength(1);
  });

  it('upgrades retry due time and its pending index idempotently', async () => {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE outbox_events DROP COLUMN next_attempt_at',
    );
    await prisma.$executeRaw`
      INSERT INTO outbox_events (
        event_type,
        payload,
        status,
        retry_count
      ) VALUES (
        'retry.legacy-pending',
        '{}'::jsonb,
        'PENDING',
        1
      )
    `;

    for (const statement of NEXT_ATTEMPT_UPGRADE_STATEMENTS) {
      await prisma.$executeRawUnsafe(statement);
      await prisma.$executeRawUnsafe(statement);
    }

    const [column] = await prisma.$queryRaw<
      Array<{ dataType: string; nextAttemptAt: Date }>
    >`
      SELECT
        c.data_type::text AS "dataType",
        e.next_attempt_at AS "nextAttemptAt"
      FROM information_schema.columns c
      JOIN outbox_events e ON e.event_type = 'retry.legacy-pending'
      WHERE c.table_schema = current_schema()
        AND c.table_name = 'outbox_events'
        AND c.column_name = 'next_attempt_at'
    `;
    const [index] = await prisma.$queryRaw<Array<{ indexDefinition: string }>>`
      SELECT indexdef::text AS "indexDefinition"
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'outbox_events'
        AND indexname = 'idx_outbox_pending'
    `;

    expect(column.dataType).toBe('timestamp with time zone');
    expect(column.nextAttemptAt).toEqual(expect.any(Date));
    expect(index.indexDefinition).toContain('next_attempt_at');
  });

  it('keeps a blocking publisher exclusively leased across two pollers', async () => {
    await prisma.$executeRaw`
      INSERT INTO outbox_events (event_type, payload)
      VALUES ('lease.blocking', '{}'::jsonb)
    `;
    let reportFirstDispatchStarted!: () => void;
    const firstDispatchStarted = new Promise<void>((resolve) => {
      reportFirstDispatchStarted = resolve;
    });
    let releaseFirstDispatch!: () => void;
    const firstDispatchBarrier = new Promise<void>((resolve) => {
      releaseFirstDispatch = resolve;
    });
    let dispatchCount = 0;
    let activeDispatches = 0;
    let maxActiveDispatches = 0;
    let eventId = '';
    let initialLeaseExpiry: Date | null = null;
    const publisher = {
      publish: jest.fn(async (record: OutboxRecord) => {
        dispatchCount++;
        activeDispatches++;
        maxActiveDispatches = Math.max(maxActiveDispatches, activeDispatches);
        try {
          if (dispatchCount === 1) {
            eventId = record.id;
            const [lease] = await prisma.$queryRaw<
              Array<{ leaseExpiresAt: Date }>
            >`
              SELECT lease_expires_at AS "leaseExpiresAt"
              FROM outbox_events
              WHERE id = ${record.id}::uuid
            `;
            initialLeaseExpiry = lease.leaseExpiresAt;
            reportFirstDispatchStarted();
            await firstDispatchBarrier;
          }
        } finally {
          activeDispatches--;
        }
      }),
    };
    const createLeasePoller = () =>
      new OutboxPoller(
        {
          prisma,
          polling: { enabled: false, batchSize: 1 },
          delivery: { mode: 'publisher' },
          lease: {
            duration: 150,
            heartbeatInterval: 40,
            heartbeatFailureTolerance: 1,
          },
        },
        publisher,
        { getHandlers: jest.fn() } as any,
        { addInterval: jest.fn(), deleteInterval: jest.fn() } as any,
      );
    const firstPoller = createLeasePoller();
    const secondPoller = createLeasePoller();

    const firstPoll = firstPoller.poll();
    await firstDispatchStarted;
    const deadline = Date.now() + 2_000;
    let heartbeatObserved = false;
    while (Date.now() < deadline) {
      const [lease] = await prisma.$queryRaw<
        Array<{ databaseNow: Date; leaseExpiresAt: Date }>
      >`
        SELECT
          NOW() AS "databaseNow",
          lease_expires_at AS "leaseExpiresAt"
        FROM outbox_events
        WHERE id = ${eventId}::uuid
      `;
      if (
        initialLeaseExpiry &&
        lease.databaseNow >= initialLeaseExpiry &&
        lease.leaseExpiresAt > lease.databaseNow
      ) {
        heartbeatObserved = true;
        break;
      }
      await sleep(10);
    }
    expect(heartbeatObserved).toBe(true);
    for (let cycle = 0; cycle < 10; cycle++) {
      await secondPoller.poll();
    }
    releaseFirstDispatch();
    await firstPoll;

    expect(maxActiveDispatches).toBe(1);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('lets two pollers claim distinct rows without duplicate initial delivery', async () => {
    await prisma.$executeRaw`
      INSERT INTO outbox_events (event_type, payload)
      VALUES
        ('claim.concurrent-a', '{}'::jsonb),
        ('claim.concurrent-b', '{}'::jsonb)
    `;
    let startedCount = 0;
    let reportBothDispatchesStarted!: () => void;
    const bothDispatchesStarted = new Promise<void>((resolve) => {
      reportBothDispatchesStarted = resolve;
    });
    let releaseDispatches!: () => void;
    const dispatchBarrier = new Promise<void>((resolve) => {
      releaseDispatches = resolve;
    });
    const deliveredIds: string[] = [];
    const publisher = {
      publish: jest.fn(async (record: OutboxRecord) => {
        deliveredIds.push(record.id);
        startedCount++;
        if (startedCount === 2) reportBothDispatchesStarted();
        await dispatchBarrier;
      }),
    };
    const createPoller = () =>
      new OutboxPoller(
        {
          prisma,
          polling: { enabled: false, batchSize: 1 },
          delivery: { mode: 'publisher' },
          lease: { duration: 1_000, heartbeatInterval: 100 },
        },
        publisher,
        { getHandlers: jest.fn() } as any,
        { addInterval: jest.fn(), deleteInterval: jest.fn() } as any,
      );

    const polls = Promise.all([createPoller().poll(), createPoller().poll()]);
    await bothDispatchesStarted;

    expect(new Set(deliveredIds).size).toBe(2);
    releaseDispatches();
    await polls;

    const rows = await prisma.$queryRaw<Array<{ status: string }>>`
      SELECT status
      FROM outbox_events
      WHERE event_type IN ('claim.concurrent-a', 'claim.concurrent-b')
      ORDER BY event_type
    `;
    expect(rows).toEqual([{ status: 'SENT' }, { status: 'SENT' }]);
    expect(publisher.publish).toHaveBeenCalledTimes(2);
  });

  it('recovers an expired process-loss lease without spending retry budget', async () => {
    await prisma.$executeRaw`
      INSERT INTO outbox_events (
        event_type,
        payload,
        status,
        claim_token,
        lease_expires_at,
        retry_count
      ) VALUES (
        'lease.process-loss',
        '{}'::jsonb,
        'PROCESSING',
        gen_random_uuid(),
        NOW() - INTERVAL '1 second',
        0
      )
    `;
    await prisma.$executeRaw`
      INSERT INTO outbox_events (
        event_type,
        payload,
        status,
        claim_token,
        lease_expires_at,
        updated_at,
        retry_count
      ) VALUES (
        'lease.legacy-process-loss',
        '{}'::jsonb,
        'PROCESSING',
        gen_random_uuid(),
        NULL,
        NOW() - INTERVAL '1 second',
        0
      )
    `;
    const publisher = { publish: jest.fn().mockResolvedValue(undefined) };
    const poller = new OutboxPoller(
      {
        prisma,
        polling: { enabled: false, batchSize: 2 },
        delivery: { mode: 'publisher' },
        lease: { duration: 150, heartbeatInterval: 40 },
      },
      publisher,
      { getHandlers: jest.fn() } as any,
      { addInterval: jest.fn(), deleteInterval: jest.fn() } as any,
    );

    for (let cycle = 0; cycle < 10; cycle++) {
      await poller.poll();
    }

    const rows = await prisma.$queryRaw<
      Array<{ status: string; retryCount: number }>
    >`
      SELECT status, retry_count AS "retryCount"
      FROM outbox_events
      WHERE event_type IN ('lease.process-loss', 'lease.legacy-process-loss')
      ORDER BY event_type
    `;
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(rows).toEqual([
      { status: 'SENT', retryCount: 0 },
      { status: 'SENT', retryCount: 0 },
    ]);
  });

  it('redelivers after publisher acceptance is persisted before SENT', async () => {
    await prisma.$executeRaw`
      INSERT INTO outbox_events (event_type, payload)
      VALUES ('publisher.ack-before-sent-loss', '{}'::jsonb)
    `;
    const acceptedIds: string[] = [];
    const publisher = {
      publish: jest.fn(async (record: OutboxRecord) => {
        acceptedIds.push(record.id);
        if (acceptedIds.length === 1) {
          // Model the durable database snapshot left when a process disappears
          // after the publisher accepts the record but before markSent can win.
          await prisma.$executeRaw`
            UPDATE outbox_events
            SET lease_expires_at = NOW() - INTERVAL '1 second'
            WHERE id = ${record.id}::uuid
              AND status = 'PROCESSING'
          `;
        }
      }),
    };
    const createPoller = () =>
      new OutboxPoller(
        {
          prisma,
          polling: { enabled: false, batchSize: 1 },
          delivery: { mode: 'publisher' },
          lease: { duration: 1_000, heartbeatInterval: 100 },
        },
        publisher,
        { getHandlers: jest.fn() } as any,
        { addInterval: jest.fn(), deleteInterval: jest.fn() } as any,
      );
    const crashedPoller = createPoller();
    const recoveryPoller = createPoller();

    await crashedPoller.poll();

    const processing = await prisma.$queryRaw<
      Array<{ id: string; status: string; processedAt: Date | null }>
    >`
      SELECT id, status, processed_at AS "processedAt"
      FROM outbox_events
      WHERE event_type = 'publisher.ack-before-sent-loss'
    `;
    expect(processing).toEqual([
      {
        id: acceptedIds[0],
        status: 'PROCESSING',
        processedAt: null,
      },
    ]);

    for (let cycle = 0; cycle < 10; cycle++) {
      await recoveryPoller.poll();
    }

    const terminal = await prisma.$queryRaw<
      Array<{ status: string; retryCount: number; processedAt: Date | null }>
    >`
      SELECT
        status,
        retry_count AS "retryCount",
        processed_at AS "processedAt"
      FROM outbox_events
      WHERE event_type = 'publisher.ack-before-sent-loss'
    `;
    expect(acceptedIds).toEqual([processing[0].id, processing[0].id]);
    expect(terminal).toEqual([
      {
        status: 'SENT',
        retryCount: 0,
        processedAt: expect.any(Date),
      },
    ]);
  });

  it('coalesces notification bursts with polling fallback against PostgreSQL', async () => {
    let reportFirstQueryStarted!: () => void;
    const firstQueryStarted = new Promise<void>((resolve) => {
      reportFirstQueryStarted = resolve;
    });
    let releaseFirstQuery!: () => void;
    const firstQueryBarrier = new Promise<void>((resolve) => {
      releaseFirstQuery = resolve;
    });
    let queryCount = 0;
    let activeQueries = 0;
    let maxActiveQueries = 0;
    const coordinatedPrisma = {
      $queryRaw: async (...args: any[]) => {
        queryCount++;
        activeQueries++;
        maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
        try {
          if (queryCount === 1) {
            reportFirstQueryStarted();
            await firstQueryBarrier;
          }
          return await Reflect.apply(prisma.$queryRaw, prisma, args);
        } finally {
          activeQueries--;
        }
      },
      $executeRaw: (...args: any[]) =>
        Reflect.apply(prisma.$executeRaw, prisma, args),
    };
    const notificationHandlers: Record<
      string,
      Array<(payload: any) => void>
    > = {};
    const notificationClient: OutboxNotificationClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
      on: jest.fn((event: string, handler: (payload: any) => void) => {
        notificationHandlers[event] ??= [];
        notificationHandlers[event].push(handler);
        return notificationClient;
      }),
    };
    const options = {
      prisma: coordinatedPrisma,
      polling: { enabled: false, batchSize: 1 },
      wakeup: {
        enabled: true,
        channel: 'outbox_p0_gate',
        clientFactory: () => notificationClient,
      },
    };
    const poller = new OutboxPoller(
      options,
      { publish: jest.fn().mockResolvedValue(undefined) },
      { getHandlers: jest.fn() } as any,
      { addInterval: jest.fn(), deleteInterval: jest.fn() } as any,
    );
    const listener = new OutboxListener(options, poller);
    await listener.onModuleInit();

    notificationHandlers.notification[0]({ channel: 'outbox_p0_gate' });
    await firstQueryStarted;
    for (let index = 0; index < 100; index++) {
      notificationHandlers.notification[0]({ channel: 'outbox_p0_gate' });
    }
    poller.requestPoll();
    const completion = poller.poll();

    expect(queryCount).toBe(1);
    releaseFirstQuery();
    await completion;
    await listener.onApplicationShutdown();

    expect(queryCount).toBe(2);
    expect(maxActiveQueries).toBe(1);
  });

  it.each([
    {
      name: 'successful dispatch',
      retryCount: 0,
      maxRetries: 5,
      error: undefined,
    },
    {
      name: 'retriable failure',
      retryCount: 1,
      maxRetries: 5,
      error: new Error('retry'),
    },
    {
      name: 'terminal failure',
      retryCount: 2,
      maxRetries: 3,
      error: new Error('dead letter'),
    },
  ])(
    'rejects a stale claim token after $name',
    async ({ retryCount, maxRetries, error }) => {
      const replacementToken = '00000000-0000-4000-8000-000000000002';
      await prisma.$executeRaw`
        INSERT INTO outbox_events (
          event_type,
          payload,
          retry_count,
          max_retries,
          next_attempt_at,
          updated_at
        ) VALUES (
          'claim.fence',
          '{}'::jsonb,
          ${retryCount},
          ${maxRetries},
          CASE
            WHEN ${retryCount} = 0 THEN NULL
            ELSE NOW() - INTERVAL '1 minute'
          END,
          NOW() - INTERVAL '1 minute'
        )
      `;
      const hooks = {
        onDispatchSuccess: jest.fn(),
        onDispatchFailure: jest.fn(),
        onRetryScheduled: jest.fn(),
        onDeadLetter: jest.fn(),
      };
      const publisher = {
        publish: jest.fn(async (record: OutboxRecord) => {
          await prisma.$executeRaw`
            UPDATE outbox_events
            SET claim_token = ${replacementToken}::uuid
            WHERE id = ${record.id}::uuid
              AND status = 'PROCESSING'
          `;
          if (error) throw error;
        }),
      };
      const poller = new OutboxPoller(
        {
          prisma,
          polling: { enabled: false, batchSize: 1 },
          retry: { backoff: 'fixed', initialDelay: 0 },
          delivery: { mode: 'publisher' },
          hooks,
        },
        publisher,
        { getHandlers: jest.fn() } as any,
        { addInterval: jest.fn(), deleteInterval: jest.fn() } as any,
      );

      await poller.poll();

      const rows = await prisma.$queryRaw<
        Array<{ status: string; claimToken: string; retryCount: number }>
      >`
        SELECT
          status,
          claim_token::text AS "claimToken",
          retry_count AS "retryCount"
        FROM outbox_events
        WHERE event_type = 'claim.fence'
      `;
      expect(rows).toEqual([
        {
          status: 'PROCESSING',
          claimToken: replacementToken,
          retryCount,
        },
      ]);
      expect(hooks.onDispatchSuccess).not.toHaveBeenCalled();
      expect(hooks.onDispatchFailure).not.toHaveBeenCalled();
      expect(hooks.onRetryScheduled).not.toHaveBeenCalled();
      expect(hooks.onDeadLetter).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: 'PENDING', error: undefined },
    { status: 'SENT', error: undefined },
    { status: 'FAILED', error: new Error('late failure') },
  ] as const)(
    'rejects a poller transition after the claim becomes $status',
    async ({ status, error }) => {
      await prisma.$executeRaw`
        INSERT INTO outbox_events (event_type, payload)
        VALUES ('claim.illegal-transition', '{}'::jsonb)
      `;
      const hooks = {
        onDispatchSuccess: jest.fn(),
        onDispatchFailure: jest.fn(),
        onRetryScheduled: jest.fn(),
        onDeadLetter: jest.fn(),
      };
      const publisher = {
        publish: jest.fn(async (record: OutboxRecord) => {
          await prisma.$executeRawUnsafe(
            `UPDATE outbox_events
             SET status = $1, claim_token = NULL
             WHERE id = $2::uuid`,
            status,
            record.id,
          );
          if (error) throw error;
        }),
      };
      const poller = new OutboxPoller(
        {
          prisma,
          polling: { enabled: false, batchSize: 1 },
          delivery: { mode: 'publisher' },
          hooks,
        },
        publisher,
        { getHandlers: jest.fn() } as any,
        { addInterval: jest.fn(), deleteInterval: jest.fn() } as any,
      );

      await poller.poll();

      const rows = await prisma.$queryRaw<Array<{ status: string }>>`
        SELECT status
        FROM outbox_events
        WHERE event_type = 'claim.illegal-transition'
      `;
      expect(rows).toEqual([{ status }]);
      expect(hooks.onDispatchSuccess).not.toHaveBeenCalled();
      expect(hooks.onDispatchFailure).not.toHaveBeenCalled();
      expect(hooks.onRetryScheduled).not.toHaveBeenCalled();
      expect(hooks.onDeadLetter).not.toHaveBeenCalled();
    },
  );

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

  it('keeps a persisted retry due time across pollers with different backoff settings', async () => {
    await prisma.$executeRaw`
      INSERT INTO outbox_events (event_type, payload, max_retries)
      VALUES ('retry.persisted-due', '{}'::jsonb, 5)
    `;
    const firstPublisher = {
      publish: jest.fn().mockRejectedValue(new Error('broker unavailable')),
    };
    const secondPublisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    };
    const createPoller = (
      publisher: { publish: jest.Mock },
      retry: {
        backoff: 'fixed' | 'exponential';
        initialDelay: number;
      },
    ) =>
      new OutboxPoller(
        {
          prisma,
          polling: { enabled: false, batchSize: 1 },
          delivery: { mode: 'publisher' },
          retry: { maxRetries: 5, ...retry },
        },
        publisher,
        { getHandlers: jest.fn() } as any,
        { addInterval: jest.fn(), deleteInterval: jest.fn() } as any,
      );
    const schedulingPoller = createPoller(firstPublisher, {
      backoff: 'exponential',
      initialDelay: 60_000,
    });
    const differentlyConfiguredPoller = createPoller(secondPublisher, {
      backoff: 'fixed',
      initialDelay: 0,
    });

    await schedulingPoller.poll();

    const [scheduled] = await prisma.$queryRaw<
      Array<{
        databaseNow: Date;
        nextAttemptAt: Date;
        retryCount: number;
      }>
    >`
      SELECT
        NOW() AS "databaseNow",
        next_attempt_at AS "nextAttemptAt",
        retry_count AS "retryCount"
      FROM outbox_events
      WHERE event_type = 'retry.persisted-due'
    `;
    expect(scheduled.retryCount).toBe(1);
    expect(scheduled.nextAttemptAt.getTime()).toBeGreaterThan(
      scheduled.databaseNow.getTime(),
    );

    await differentlyConfiguredPoller.poll();
    expect(secondPublisher.publish).not.toHaveBeenCalled();

    await prisma.$executeRaw`
      UPDATE outbox_events
      SET next_attempt_at = NOW()
      WHERE event_type = 'retry.persisted-due'
    `;
    await differentlyConfiguredPoller.poll();

    expect(secondPublisher.publish).toHaveBeenCalledTimes(1);
    const [terminal] = await prisma.$queryRaw<
      Array<{ status: string; nextAttemptAt: Date | null }>
    >`
      SELECT status, next_attempt_at AS "nextAttemptAt"
      FROM outbox_events
      WHERE event_type = 'retry.persisted-due'
    `;
    expect(terminal).toEqual({ status: 'SENT', nextAttemptAt: null });
  });

  it('makes a manual retry due now without resetting its retry count', async () => {
    await prisma.$executeRaw`
      INSERT INTO outbox_events (
        event_type,
        payload,
        status,
        retry_count,
        last_error,
        processed_at
      ) VALUES (
        'retry.manual-due-now',
        '{}'::jsonb,
        'FAILED',
        2,
        'operator retry requested',
        NOW() - INTERVAL '1 hour'
      )
    `;
    const [failed] = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM outbox_events
      WHERE event_type = 'retry.manual-due-now'
    `;
    const admin = new OutboxAdminService({ prisma });

    await expect(admin.retry(failed.id)).resolves.toEqual({
      outcome: 'applied',
    });

    const [retried] = await prisma.$queryRaw<
      Array<{
        status: string;
        retryCount: number;
        lastError: string | null;
        processedAt: Date | null;
        nextAttemptAt: Date;
        databaseNow: Date;
      }>
    >`
      SELECT
        status,
        retry_count AS "retryCount",
        last_error AS "lastError",
        processed_at AS "processedAt",
        next_attempt_at AS "nextAttemptAt",
        NOW() AS "databaseNow"
      FROM outbox_events
      WHERE id = ${failed.id}::uuid
    `;
    expect(retried).toEqual({
      status: 'PENDING',
      retryCount: 2,
      lastError: null,
      processedAt: null,
      nextAttemptAt: expect.any(Date),
      databaseNow: expect.any(Date),
    });
    expect(retried.nextAttemptAt.getTime()).toBeLessThanOrEqual(
      retried.databaseNow.getTime(),
    );
  });

  it('enforces the admin source-state matrix and mutation invariants', async () => {
    await prisma.$executeRaw`
      INSERT INTO outbox_events (
        event_type,
        payload,
        status,
        retry_count,
        last_error,
        processed_at,
        next_attempt_at,
        claim_token,
        lease_expires_at
      ) VALUES
        (
          'admin.pending',
          '{}'::jsonb,
          'PENDING',
          1,
          NULL,
          NULL,
          NOW(),
          NULL,
          NULL
        ),
        (
          'admin.processing',
          '{}'::jsonb,
          'PROCESSING',
          0,
          NULL,
          NULL,
          NULL,
          gen_random_uuid(),
          NOW() + INTERVAL '1 minute'
        ),
        (
          'admin.sent',
          '{}'::jsonb,
          'SENT',
          0,
          NULL,
          NOW() - INTERVAL '1 hour',
          NULL,
          NULL,
          NULL
        ),
        (
          'admin.failed',
          '{}'::jsonb,
          'FAILED',
          2,
          'delivery stopped',
          NOW() - INTERVAL '1 hour',
          NULL,
          NULL,
          NULL
        )
    `;
    const rows = await prisma.$queryRaw<
      Array<{ id: string; eventType: string }>
    >`
      SELECT id, event_type AS "eventType"
      FROM outbox_events
      WHERE event_type LIKE 'admin.%'
    `;
    const ids = Object.fromEntries(
      rows.map((row: { id: string; eventType: string }) => [
        row.eventType,
        row.id,
      ]),
    ) as Record<string, string>;
    const admin = new OutboxAdminService({ prisma });

    await expect(
      admin.markFailed(ids['admin.pending'], 'operator stop'),
    ).resolves.toEqual({ outcome: 'applied' });
    await expect(
      admin.markFailed(ids['admin.processing'], 'operator stop'),
    ).resolves.toEqual({
      outcome: 'conflict',
      currentStatus: 'PROCESSING',
    });
    await expect(admin.retry(ids['admin.failed'])).resolves.toEqual({
      outcome: 'applied',
    });
    await expect(admin.retry(ids['admin.sent'])).resolves.toEqual({
      outcome: 'conflict',
      currentStatus: 'SENT',
    });
    await expect(
      admin.retry('00000000-0000-4000-8000-000000000099'),
    ).resolves.toEqual({ outcome: 'not_found' });
    await expect(
      admin.purgeSent({ before: new Date(), limit: 10 }),
    ).resolves.toBe(1);

    const remaining = await prisma.$queryRaw<
      Array<{
        eventType: string;
        status: string;
        retryCount: number;
        lastError: string | null;
        processedAt: Date | null;
        nextAttemptAt: Date | null;
        claimToken: string | null;
      }>
    >`
      SELECT
        event_type AS "eventType",
        status,
        retry_count AS "retryCount",
        last_error AS "lastError",
        processed_at AS "processedAt",
        next_attempt_at AS "nextAttemptAt",
        claim_token::text AS "claimToken"
      FROM outbox_events
      WHERE event_type LIKE 'admin.%'
      ORDER BY event_type
    `;
    expect(remaining).toEqual([
      {
        eventType: 'admin.failed',
        status: 'PENDING',
        retryCount: 2,
        lastError: null,
        processedAt: null,
        nextAttemptAt: expect.any(Date),
        claimToken: null,
      },
      {
        eventType: 'admin.pending',
        status: 'FAILED',
        retryCount: 1,
        lastError: 'operator stop',
        processedAt: expect.any(Date),
        nextAttemptAt: null,
        claimToken: null,
      },
      {
        eventType: 'admin.processing',
        status: 'PROCESSING',
        retryCount: 0,
        lastError: null,
        processedAt: null,
        nextAttemptAt: null,
        claimToken: expect.any(String),
      },
    ]);
  });

  it('does not let admin markFailed invert an active poller completion', async () => {
    await prisma.$executeRaw`
      INSERT INTO outbox_events (event_type, payload)
      VALUES ('admin.active-race', '{}'::jsonb)
    `;
    let reportDispatchStarted!: (id: string) => void;
    const dispatchStarted = new Promise<string>((resolve) => {
      reportDispatchStarted = resolve;
    });
    let releaseDispatch!: () => void;
    const dispatchBarrier = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const publisher = {
      publish: jest.fn(async (record: OutboxRecord) => {
        reportDispatchStarted(record.id);
        await dispatchBarrier;
      }),
    };
    const poller = new OutboxPoller(
      {
        prisma,
        polling: { enabled: false, batchSize: 1 },
        delivery: { mode: 'publisher' },
        lease: { duration: 1_000, heartbeatInterval: 100 },
      },
      publisher,
      { getHandlers: jest.fn() } as any,
      { addInterval: jest.fn(), deleteInterval: jest.fn() } as any,
    );
    const admin = new OutboxAdminService({ prisma });
    const polling = poller.poll();
    const id = await dispatchStarted;

    await expect(admin.markFailed(id, 'operator stop')).resolves.toEqual({
      outcome: 'conflict',
      currentStatus: 'PROCESSING',
    });
    releaseDispatch();
    await polling;

    const terminal = await prisma.$queryRaw<Array<{ status: string }>>`
      SELECT status
      FROM outbox_events
      WHERE id = ${id}::uuid
    `;
    expect(terminal).toEqual([{ status: 'SENT' }]);
  });

  it('reports lost_claim when a concurrent transition wins after CAS observation', async () => {
    await prisma.$executeRaw`
      INSERT INTO outbox_events (
        event_type,
        payload,
        status,
        last_error,
        processed_at
      ) VALUES (
        'admin.lost-claim',
        '{}'::jsonb,
        'FAILED',
        'delivery stopped',
        NOW()
      )
    `;
    const [row] = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM outbox_events
      WHERE event_type = 'admin.lost-claim'
    `;
    let reportLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      reportLockHeld = resolve;
    });
    let releaseLock!: () => void;
    const lockBarrier = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const concurrentTransition = prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`
        UPDATE outbox_events
        SET updated_at = NOW()
        WHERE id = ${row.id}::uuid
      `;
      reportLockHeld();
      await lockBarrier;
      await tx.$executeRaw`
        UPDATE outbox_events
        SET status = 'SENT',
            last_error = NULL,
            processed_at = NOW(),
            next_attempt_at = NULL,
            updated_at = NOW()
        WHERE id = ${row.id}::uuid
      `;
    });
    await lockHeld;

    const admin = new OutboxAdminService({ prisma });
    const retrying = admin.retry(row.id);
    const deadline = Date.now() + 2_000;
    let casWaitingOnLock = false;
    while (Date.now() < deadline) {
      const [activity] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query LIKE '%WITH target AS MATERIALIZED%'
        ) AS waiting
      `;
      if (activity.waiting) {
        casWaitingOnLock = true;
        break;
      }
      await sleep(10);
    }
    releaseLock();
    await concurrentTransition;
    expect(casWaitingOnLock).toBe(true);
    await expect(retrying).resolves.toEqual({ outcome: 'lost_claim' });

    const terminal = await prisma.$queryRaw<Array<{ status: string }>>`
      SELECT status
      FROM outbox_events
      WHERE id = ${row.id}::uuid
    `;
    expect(terminal).toEqual([{ status: 'SENT' }]);
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
      await expect(admin.retry(failed[0].id)).resolves.toEqual({
        outcome: 'applied',
      });

      await sleep(1000);

      const sent = await prisma.$queryRaw<any[]>`
        SELECT * FROM outbox_events WHERE id = ${failed[0].id}::uuid
      `;
      expect(sent[0].status).toBe('SENT');
      expect(toggleListener.callCount).toBeGreaterThanOrEqual(2);
    });
  });
});
