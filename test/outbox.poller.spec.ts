import { OutboxPoller } from '../src/outbox.poller';
import type { OutboxOptions } from '../src/interfaces/outbox-options.interface';
import type { OutboxTransport } from '../src/interfaces/outbox-transport.interface';
import type { OutboxRecord } from '../src/interfaces/outbox-record.interface';
import type { OutboxExplorer } from '../src/outbox.explorer';
import type { SchedulerRegistry } from '@nestjs/schedule';

type ClaimedRecordFixture = OutboxRecord & { claimToken: string };

function createRecord(
  overrides?: Partial<ClaimedRecordFixture>,
): ClaimedRecordFixture {
  return {
    id: 'evt-1',
    eventType: 'order.created',
    payload: { orderId: 'order-1' },
    status: 'PROCESSING',
    createdAt: new Date(),
    updatedAt: new Date(),
    processedAt: null,
    nextAttemptAt: null,
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    tenantId: null,
    aggregateType: null,
    aggregateId: null,
    partitionKey: null,
    idempotencyKey: null,
    correlationId: null,
    causationId: null,
    headers: {},
    occurredAt: new Date(),
    claimToken: 'claim-1',
    ...overrides,
  };
}

function publicRecord(record: ClaimedRecordFixture): OutboxRecord {
  const snapshot: Partial<ClaimedRecordFixture> = { ...record };
  delete snapshot.claimToken;
  return snapshot as OutboxRecord;
}

function createMockPrisma(records: OutboxRecord[] = []) {
  const queryRaw = jest.fn().mockResolvedValue([]);
  if (records.length > 0) {
    queryRaw.mockResolvedValueOnce(records);
  }
  return {
    $queryRaw: queryRaw,
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
}

function createMockTransport(): jest.Mocked<OutboxTransport> {
  return { dispatch: jest.fn().mockResolvedValue(undefined) };
}

function createMockExplorer(
  handlerMap: Record<string, any[]> = {},
): jest.Mocked<
  Pick<OutboxExplorer, 'getHandlers' | 'getRegisteredEventTypes'>
> {
  return {
    getHandlers: jest.fn((eventType: string) => handlerMap[eventType] ?? []),
    getRegisteredEventTypes: jest.fn(() => Object.keys(handlerMap)),
  };
}

function createMockSchedulerRegistry(): jest.Mocked<
  Pick<SchedulerRegistry, 'addInterval' | 'deleteInterval'>
> {
  return {
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
  };
}

function createPoller(overrides?: {
  prisma?: any;
  transport?: any;
  explorer?: any;
  schedulerRegistry?: any;
  options?: Partial<OutboxOptions>;
}) {
  const prisma = overrides?.prisma ?? createMockPrisma();
  const options: OutboxOptions = {
    prisma,
    polling: { enabled: true, interval: 5000, batchSize: 10 },
    retry: { maxRetries: 3, backoff: 'exponential', initialDelay: 1000 },
    ...overrides?.options,
  };

  return new OutboxPoller(
    options,
    overrides?.transport ?? createMockTransport(),
    overrides?.explorer ?? createMockExplorer(),
    overrides?.schedulerRegistry ?? createMockSchedulerRegistry(),
  );
}

describe('OutboxPoller', () => {
  // Clean up any intervals created by onModuleInit
  let registeredIntervals: NodeJS.Timeout[] = [];

  afterEach(() => {
    for (const interval of registeredIntervals) {
      clearInterval(interval);
    }
    registeredIntervals = [];
    jest.useRealTimers();
  });

  describe('onModuleInit', () => {
    it('should register interval with SchedulerRegistry', () => {
      const schedulerRegistry = createMockSchedulerRegistry();
      schedulerRegistry.addInterval.mockImplementation((_name, interval) => {
        registeredIntervals.push(interval as NodeJS.Timeout);
      });
      const poller = createPoller({ schedulerRegistry });

      poller.onModuleInit();

      expect(schedulerRegistry.addInterval).toHaveBeenCalledWith(
        'outbox-poll',
        expect.anything(),
      );
    });

    it('should not register interval when polling is disabled', () => {
      const schedulerRegistry = createMockSchedulerRegistry();
      const poller = createPoller({
        schedulerRegistry,
        options: { polling: { enabled: false } },
      });

      poller.onModuleInit();

      expect(schedulerRegistry.addInterval).not.toHaveBeenCalled();
    });

    it('isolates timer poll failures and recovers on the next interval', async () => {
      jest.useFakeTimers();
      const prisma = createMockPrisma();
      prisma.$queryRaw
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValueOnce([]);
      const poller = createPoller({
        prisma,
        options: { polling: { enabled: true, interval: 100 } },
      });
      const warn = jest
        .spyOn((poller as any).logger, 'warn')
        .mockImplementation(() => undefined);

      poller.onModuleInit();

      await jest.advanceTimersByTimeAsync(100);
      expect(warn).toHaveBeenCalledWith(
        'Outbox background poll failed: database unavailable',
      );

      await jest.advanceTimersByTimeAsync(100);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      jest.useRealTimers();
    });
  });

  describe('poll', () => {
    it('does not emit success hooks when the no-handler FAILED CAS loses ownership', async () => {
      const prisma = createMockPrisma([createRecord()]);
      prisma.$executeRaw.mockResolvedValue(0);
      const hooks = { onDispatchSuccess: jest.fn(), onDeadLetter: jest.fn() };
      await createPoller({ prisma, options: { hooks } }).poll();
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(prisma.$executeRaw.mock.calls[0][0].join('')).toContain(
        "status = 'FAILED'",
      );
      expect(hooks.onDispatchSuccess).not.toHaveBeenCalled();
      expect(hooks.onDeadLetter).not.toHaveBeenCalled();
    });

    it('normalizes a non-Error publisher rejection into the persisted retry error', async () => {
      const prisma = createMockPrisma([createRecord()]);
      const onRetryScheduled = jest.fn();
      await createPoller({
        prisma,
        transport: { publish: jest.fn().mockRejectedValue('broker offline') },
        options: {
          delivery: { mode: 'publisher' },
          hooks: { onRetryScheduled },
        },
      }).poll();
      expect(prisma.$executeRaw.mock.calls[0]).toContain('broker offline');
      expect(onRetryScheduled).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'broker offline' }),
          retryCount: 1,
        }),
      );
    });

    it('waits for an in-flight heartbeat and suppresses overlapping renewals before SENT', async () => {
      jest.useFakeTimers();
      const prisma = createMockPrisma([createRecord()]);
      let renew!: (rows: number) => void;
      const renewal = new Promise<number>((resolve) => {
        renew = resolve;
      });
      prisma.$executeRaw.mockReturnValueOnce(renewal);
      let finish!: () => void;
      const dispatch = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const onDispatchSuccess = jest.fn();
      const poller = createPoller({
        prisma,
        transport: { publish: jest.fn(() => dispatch) },
        options: {
          delivery: { mode: 'publisher' },
          hooks: { onDispatchSuccess },
          lease: { duration: 300, heartbeatInterval: 100 },
        },
      });
      const pending = poller.poll();
      await jest.advanceTimersByTimeAsync(300);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      finish();
      await jest.advanceTimersByTimeAsync(0);
      expect(onDispatchSuccess).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      renew(1);
      await pending;
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
      expect(onDispatchSuccess).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });
    it.each([
      ['status', { status: 'CORRUPT' }],
      ['retry count', { retryCount: -1 }],
      ['created date', { createdAt: new Date('invalid') }],
      ['payload JSON object', { payload: [] }],
      ['headers JSON object', { headers: [] }],
    ])(
      'fails closed before delivery when persisted %s is corrupt',
      async (_label, corrupt) => {
        const record = createRecord(corrupt as Partial<ClaimedRecordFixture>);
        const prisma = createMockPrisma([record]);
        const publisher = { publish: jest.fn().mockResolvedValue(undefined) };
        const poller = createPoller({
          prisma,
          transport: publisher,
          options: {
            polling: { enabled: false, batchSize: 1 },
            delivery: { mode: 'publisher' },
          },
        });

        await expect(poller.poll()).rejects.toThrow(/persisted/i);
        expect(publisher.publish).not.toHaveBeenCalled();
      },
    );

    it('claims on demand up to the configured batch size', async () => {
      const firstRecord = createRecord({
        id: 'evt-1',
        claimToken: 'claim-1',
      });
      const secondRecord = createRecord({
        id: 'evt-2',
        claimToken: 'claim-2',
      });
      const prisma = createMockPrisma();
      prisma.$queryRaw
        .mockResolvedValueOnce([firstRecord])
        .mockResolvedValueOnce([secondRecord]);
      const publisher = { publish: jest.fn().mockResolvedValue(undefined) };
      const poller = createPoller({
        prisma,
        transport: publisher,
        options: {
          polling: { enabled: false, batchSize: 2 },
          delivery: { mode: 'publisher' },
        },
      });

      await poller.poll();

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(publisher.publish).toHaveBeenCalledTimes(2);
      expect(publisher.publish).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ id: 'evt-1' }),
      );
      expect(publisher.publish).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ id: 'evt-2' }),
      );
    });

    it('renews the lease while a publisher callback is active', async () => {
      jest.useFakeTimers();
      const record = createRecord();
      const prisma = createMockPrisma([record]);
      let reportDispatchStarted!: () => void;
      const dispatchStarted = new Promise<void>((resolve) => {
        reportDispatchStarted = resolve;
      });
      let releaseDispatch!: () => void;
      const dispatchBarrier = new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      const publisher = {
        publish: jest.fn(async () => {
          reportDispatchStarted();
          await dispatchBarrier;
        }),
      };
      const poller = createPoller({
        prisma,
        transport: publisher,
        options: {
          delivery: { mode: 'publisher' },
          lease: {
            duration: 300,
            heartbeatInterval: 100,
            heartbeatFailureTolerance: 0,
          },
        },
      });

      const poll = poller.poll();
      await dispatchStarted;
      await jest.advanceTimersByTimeAsync(100);

      const heartbeatSql = prisma.$executeRaw.mock.calls[0][0].join('');
      expect(heartbeatSql).toContain('SET lease_expires_at = NOW()');
      expect(heartbeatSql).toContain("status = 'PROCESSING'");
      expect(heartbeatSql).toContain('claim_token =');

      releaseDispatch();
      await poll;
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    });

    it('discards completion after heartbeat failures exceed tolerance', async () => {
      jest.useFakeTimers();
      const record = createRecord();
      const prisma = createMockPrisma([record]);
      prisma.$executeRaw.mockRejectedValueOnce(new Error('heartbeat offline'));
      let reportDispatchStarted!: () => void;
      const dispatchStarted = new Promise<void>((resolve) => {
        reportDispatchStarted = resolve;
      });
      let releaseDispatch!: () => void;
      const dispatchBarrier = new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      const publisher = {
        publish: jest.fn(async () => {
          reportDispatchStarted();
          await dispatchBarrier;
        }),
      };
      const hooks = { onDispatchSuccess: jest.fn() };
      const poller = createPoller({
        prisma,
        transport: publisher,
        options: {
          delivery: { mode: 'publisher' },
          hooks,
          lease: {
            duration: 300,
            heartbeatInterval: 100,
            heartbeatFailureTolerance: 0,
          },
        },
      });

      const poll = poller.poll();
      await dispatchStarted;
      await jest.advanceTimersByTimeAsync(100);
      releaseDispatch();
      await poll;

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(hooks.onDispatchSuccess).not.toHaveBeenCalled();
    });

    it('treats a zero-row heartbeat as immediate ownership loss', async () => {
      jest.useFakeTimers();
      const record = createRecord();
      const prisma = createMockPrisma([record]);
      prisma.$executeRaw.mockResolvedValueOnce(0);
      let reportDispatchStarted!: () => void;
      const dispatchStarted = new Promise<void>((resolve) => {
        reportDispatchStarted = resolve;
      });
      let releaseDispatch!: () => void;
      const dispatchBarrier = new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      const publisher = {
        publish: jest.fn(async () => {
          reportDispatchStarted();
          await dispatchBarrier;
        }),
      };
      const poller = createPoller({
        prisma,
        transport: publisher,
        options: {
          delivery: { mode: 'publisher' },
          lease: {
            duration: 300,
            heartbeatInterval: 100,
            heartbeatFailureTolerance: 10,
          },
        },
      });

      const poll = poller.poll();
      await dispatchStarted;
      await jest.advanceTimersByTimeAsync(100);
      releaseDispatch();
      await poll;

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('coalesces concurrent triggers into one in-flight poll and one rerun', async () => {
      let releaseFirstPoll!: () => void;
      const firstPollBarrier = new Promise<void>((resolve) => {
        releaseFirstPoll = resolve;
      });
      let activeQueries = 0;
      let maxActiveQueries = 0;
      const prisma = createMockPrisma();
      prisma.$queryRaw.mockImplementation(async () => {
        activeQueries++;
        maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
        try {
          if (prisma.$queryRaw.mock.calls.length === 1) {
            await firstPollBarrier;
          }
          return [];
        } finally {
          activeQueries--;
        }
      });
      const poller = createPoller({ prisma });

      const first = poller.poll();
      await Promise.resolve();
      const burst = Array.from({ length: 100 }, () => poller.poll());

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      releaseFirstPoll();
      await Promise.all([first, ...burst]);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(maxActiveQueries).toBe(1);
    });

    it('allows a later trigger to recover after a transient poll failure', async () => {
      const prisma = createMockPrisma();
      prisma.$queryRaw
        .mockRejectedValueOnce(new Error('temporary database failure'))
        .mockResolvedValueOnce([]);
      const poller = createPoller({ prisma });

      await expect(poller.poll()).rejects.toThrow('temporary database failure');
      await expect(poller.poll()).resolves.toBeUndefined();

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('keeps the claimed identity when a hook mutates its record snapshot', async () => {
      const record = createRecord({
        payload: { order: { id: 'order-1' } },
      });
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      const handler = {
        instance: {},
        methodName: 'handle',
        eventTypes: ['order.created'],
      };
      const explorer = createMockExplorer({ 'order.created': [handler] });
      const hooks = {
        onDispatchStart: jest.fn((context) => {
          const mutableRecord = context.record as unknown as {
            id: string;
            payload: { order: { id: string } };
          };
          mutableRecord.id = 'evt-2';
          mutableRecord.payload.order.id = 'order-2';
        }),
      };

      const poller = createPoller({
        prisma,
        transport,
        explorer,
        options: { hooks },
      });
      await poller.poll();

      expect(transport.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'evt-1',
          payload: { order: { id: 'order-1' } },
        }),
        [handler],
        expect.objectContaining({ eventId: 'evt-1' }),
      );
      const [, ...transitionValues] = prisma.$executeRaw.mock.calls[0];
      expect(transitionValues).toContain('evt-1');
      expect(transitionValues).toContain('claim-1');
      expect(transitionValues).not.toContain('evt-2');
    });

    it('keeps canonical retry state when a publisher mutates every public field', async () => {
      const record = createRecord({
        retryCount: 1,
        maxRetries: 5,
        tenantId: 'tenant-1',
        payload: { order: { id: 'order-1' } },
      });
      const prisma = createMockPrisma([record]);
      const publisher = {
        publish: jest.fn(async (publishedRecord: OutboxRecord) => {
          const mutable = publishedRecord as unknown as Record<string, unknown>;
          mutable.id = 'evt-2';
          mutable.status = 'SENT';
          mutable.retryCount = 99;
          mutable.maxRetries = 1;
          mutable.tenantId = 'tenant-2';
          (mutable.payload as { order: { id: string } }).order.id = 'order-2';
          throw new Error('broker unavailable');
        }),
      };
      const hooks = {
        onDispatchFailure: jest.fn(),
        onRetryScheduled: jest.fn(),
      };
      const poller = createPoller({
        prisma,
        transport: publisher,
        options: { delivery: { mode: 'publisher' }, hooks },
      });

      await poller.poll();

      const [strings, ...values] = prisma.$executeRaw.mock.calls[0];
      expect(strings.join('')).toContain("SET status = 'PENDING'");
      expect(values).toEqual(expect.arrayContaining([2, 'evt-1', 'claim-1']));
      expect(values).not.toEqual(expect.arrayContaining(['evt-2', 99]));
      expect(hooks.onRetryScheduled).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'evt-1',
          tenantId: 'tenant-1',
          retryCount: 2,
          maxRetries: 5,
          record: expect.objectContaining({
            id: 'evt-1',
            payload: { order: { id: 'order-1' } },
          }),
        }),
      );
    });

    it.each([
      {
        name: 'success to SENT',
        record: createRecord(),
        transportError: undefined,
        expectedHook: 'onDispatchSuccess',
      },
      {
        name: 'retriable failure to PENDING',
        record: createRecord({ retryCount: 1, maxRetries: 5 }),
        transportError: new Error('retry'),
        expectedHook: 'onRetryScheduled',
      },
      {
        name: 'terminal failure to FAILED',
        record: createRecord({ retryCount: 2, maxRetries: 3 }),
        transportError: new Error('dead letter'),
        expectedHook: 'onDeadLetter',
      },
    ])(
      'treats a zero-row $name transition as a lost claim',
      async ({ record, transportError, expectedHook }) => {
        const prisma = createMockPrisma([record]);
        prisma.$executeRaw.mockResolvedValue(0);
        const transport = createMockTransport();
        if (transportError) {
          transport.dispatch.mockRejectedValue(transportError);
        }
        const handler = {
          instance: {},
          methodName: 'handle',
          eventTypes: ['order.created'],
        };
        const explorer = createMockExplorer({ 'order.created': [handler] });
        const hooks = {
          onDispatchSuccess: jest.fn(),
          onDispatchFailure: jest.fn(),
          onRetryScheduled: jest.fn(),
          onDeadLetter: jest.fn(),
        };
        const poller = createPoller({
          prisma,
          transport,
          explorer,
          options: { hooks },
        });

        await poller.poll();

        const sql = prisma.$executeRaw.mock.calls[0][0].join('');
        expect(sql).toContain("status = 'PROCESSING'");
        expect(sql).toContain('claim_token =');
        expect(
          hooks[expectedHook as keyof typeof hooks],
        ).not.toHaveBeenCalled();
        if (transportError) {
          expect(hooks.onDispatchFailure).not.toHaveBeenCalled();
        }
      },
    );

    it('claims rows with a private token that is not exposed to callbacks', async () => {
      const record = createRecord();
      const prisma = createMockPrisma([record]);
      const publisher = { publish: jest.fn().mockResolvedValue(undefined) };
      const poller = createPoller({
        prisma,
        transport: publisher,
        options: { delivery: { mode: 'publisher' } },
      });

      await poller.poll();

      const claimSql = prisma.$queryRaw.mock.calls[0][0].join('');
      expect(claimSql).toContain('claim_token = gen_random_uuid()');
      expect(claimSql).toContain('lease_expires_at = NOW()');
      expect(claimSql).toContain('claim_token AS "claimToken"');
      expect(publisher.publish).toHaveBeenCalledWith(
        expect.not.objectContaining({ claimToken: expect.anything() }),
      );
    });

    it('should fetch events and dispatch to transport', async () => {
      const record = createRecord();
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      const handler = {
        instance: {},
        methodName: 'handle',
        eventTypes: ['order.created'],
      };
      const explorer = createMockExplorer({ 'order.created': [handler] });

      const poller = createPoller({ prisma, transport, explorer });
      await poller.poll();

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(transport.dispatch).toHaveBeenCalledWith(
        publicRecord(record),
        [handler],
        expect.objectContaining({
          eventId: record.id,
          eventType: record.eventType,
          tenantId: null,
        }),
      );
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it('should mark event as FAILED when no handlers exist', async () => {
      const record = createRecord();
      const prisma = createMockPrisma([record]);
      const explorer = createMockExplorer({});

      const poller = createPoller({ prisma, explorer });
      await poller.poll();

      // Should call $executeRaw to mark as FAILED (not SENT)
      expect(prisma.$executeRaw).toHaveBeenCalled();
      const call = prisma.$executeRaw.mock.calls[0];
      const sqlStrings = call[0].join('');
      expect(sqlStrings).toContain('FAILED');
    });

    it('should publish events in publisher mode without registered handlers', async () => {
      const record = createRecord();
      const prisma = createMockPrisma([record]);
      const publisher = { publish: jest.fn().mockResolvedValue(undefined) };
      const explorer = createMockExplorer({});

      const poller = createPoller({
        prisma,
        transport: publisher,
        explorer,
        options: { delivery: { mode: 'publisher' } },
      });
      await poller.poll();

      expect(explorer.getHandlers).not.toHaveBeenCalled();
      expect(publisher.publish).toHaveBeenCalledWith(publicRecord(record));
      const sql = prisma.$executeRaw.mock.calls[0][0].join('');
      expect(sql).toContain('SENT');
    });

    it('should retry publisher mode failures without requiring handlers', async () => {
      const record = createRecord({ retryCount: 1, maxRetries: 5 });
      const prisma = createMockPrisma([record]);
      const publisher = {
        publish: jest.fn().mockRejectedValue(new Error('broker unavailable')),
      };
      const explorer = createMockExplorer({});

      const poller = createPoller({
        prisma,
        transport: publisher,
        explorer,
        options: { delivery: { mode: 'publisher' } },
      });
      await poller.poll();

      expect(explorer.getHandlers).not.toHaveBeenCalled();
      expect(publisher.publish).toHaveBeenCalledWith(publicRecord(record));
      const [strings, ...values] = prisma.$executeRaw.mock.calls[0];
      expect(strings.join('')).toContain('PENDING');
      expect(values).toContain(2);
      expect(values).toContain('broker unavailable');
    });

    it('should support legacy dispatch transports in publisher mode without handlers', async () => {
      const record = createRecord();
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      const explorer = createMockExplorer({});

      const poller = createPoller({
        prisma,
        transport,
        explorer,
        options: { delivery: { mode: 'publisher' } },
      });
      await poller.poll();

      expect(explorer.getHandlers).not.toHaveBeenCalled();
      expect(transport.dispatch).toHaveBeenCalledWith(publicRecord(record), []);
      const sql = prisma.$executeRaw.mock.calls[0][0].join('');
      expect(sql).toContain('SENT');
    });

    it('should revert to PENDING with incremented retry_count and last_error on failure', async () => {
      const record = createRecord({ retryCount: 1, maxRetries: 5 });
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      transport.dispatch.mockRejectedValue(new Error('handler failed'));
      const handler = {
        instance: {},
        methodName: 'handle',
        eventTypes: ['order.created'],
      };
      const explorer = createMockExplorer({ 'order.created': [handler] });

      const poller = createPoller({ prisma, transport, explorer });
      await poller.poll();

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = prisma.$executeRaw.mock.calls[0];
      const sql = strings.join('');
      // Should set status to PENDING (retry, not final failure)
      expect(sql).toContain('PENDING');
      expect(sql).not.toContain('FAILED');
      // Should pass incremented retry_count (1 → 2)
      expect(values).toContain(2);
      // Should pass error message
      expect(values).toContain('handler failed');
    });

    it('persists retry due time once and claims only from the stored database time', async () => {
      const record = createRecord({ retryCount: 0, maxRetries: 5 });
      const firstPrisma = createMockPrisma([record]);
      const failingTransport = createMockTransport();
      failingTransport.dispatch.mockRejectedValue(new Error('retry later'));
      const handler = {
        instance: {},
        methodName: 'handle',
        eventTypes: ['order.created'],
      };
      const explorer = createMockExplorer({ 'order.created': [handler] });
      const firstPoller = createPoller({
        prisma: firstPrisma,
        transport: failingTransport,
        explorer,
        options: {
          retry: {
            maxRetries: 5,
            backoff: 'exponential',
            initialDelay: 1_000,
          },
        },
      });

      await firstPoller.poll();

      const [failureStrings, ...failureValues] =
        firstPrisma.$executeRaw.mock.calls[0];
      const failureSql = failureStrings.join('');
      expect(failureSql).toContain(
        'next_attempt_at = NOW() + make_interval(secs =>',
      );
      expect(failureValues).toContain(1);

      const secondPrisma = createMockPrisma();
      const secondPoller = createPoller({
        prisma: secondPrisma,
        options: {
          retry: { maxRetries: 5, backoff: 'fixed', initialDelay: 60_000 },
        },
      });

      await secondPoller.poll();

      const [claimStrings, ...claimValues] =
        secondPrisma.$queryRaw.mock.calls[0];
      const claimSql = claimStrings.join('');
      expect(claimSql).toContain('next_attempt_at <= NOW()');
      expect(claimSql).not.toContain('pow(2, retry_count - 1)');
      expect(claimValues).not.toContain('fixed');
      expect(claimValues).not.toContain(60);
    });

    it('caps exponential retry delay before numeric overflow', async () => {
      const record = createRecord({ retryCount: 1_000, maxRetries: 1_002 });
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      transport.dispatch.mockRejectedValue(new Error('still unavailable'));
      const explorer = createMockExplorer({
        'order.created': [
          {
            instance: {},
            methodName: 'handle',
            eventTypes: ['order.created'],
          },
        ],
      });
      const poller = createPoller({
        prisma,
        transport,
        explorer,
        options: {
          retry: {
            maxRetries: 1_002,
            backoff: 'exponential',
            initialDelay: 1,
            maxDelay: 5_000,
          },
        },
      });

      await poller.poll();

      const [, ...values] = prisma.$executeRaw.mock.calls[0];
      expect(values).toContain(5);
    });

    it('should mark as FAILED with last_error when record.maxRetries exceeded', async () => {
      const record = createRecord({ retryCount: 2, maxRetries: 3 });
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      transport.dispatch.mockRejectedValue(new Error('still failing'));
      const handler = {
        instance: {},
        methodName: 'handle',
        eventTypes: ['order.created'],
      };
      const explorer = createMockExplorer({ 'order.created': [handler] });

      const poller = createPoller({ prisma, transport, explorer });
      await poller.poll();

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = prisma.$executeRaw.mock.calls[0];
      const sql = strings.join('');
      // Should set status to FAILED (max retries reached)
      expect(sql).toContain('FAILED');
      // Should pass incremented retry_count (2 → 3)
      expect(values).toContain(3);
      // Should pass error message
      expect(values).toContain('still failing');
    });

    it('should not poll when shutting down', async () => {
      const prisma = createMockPrisma();
      const poller = createPoller({ prisma });

      await poller.onApplicationShutdown();
      await poller.poll();

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('should do nothing when no pending events', async () => {
      const prisma = createMockPrisma([]);
      const transport = createMockTransport();

      const poller = createPoller({ prisma, transport });
      await poller.poll();

      expect(transport.dispatch).not.toHaveBeenCalled();
    });

    it('should recover stuck events on every 10th poll cycle', async () => {
      const prisma = createMockPrisma([]);
      const poller = createPoller({ prisma });

      // Poll 9 times — no recovery
      for (let i = 0; i < 9; i++) {
        await poller.poll();
      }
      // $executeRaw should not have been called (no stuck recovery, no events)
      expect(prisma.$executeRaw).not.toHaveBeenCalled();

      // 10th poll — should trigger stuck recovery
      await poller.poll();
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const call = prisma.$executeRaw.mock.calls[0];
      const sqlStrings = call[0].join('');
      expect(sqlStrings).toContain('PROCESSING');
      expect(sqlStrings).toContain('PENDING');
      expect(sqlStrings).toContain('lease_expires_at <= NOW()');
      expect(sqlStrings).toContain('lease_expires_at IS NULL');
      expect(sqlStrings).toContain('updated_at <= NOW()');
      expect(sqlStrings).not.toContain('retry_count');
    });

    it('should use record.maxRetries for failure threshold', async () => {
      // Record has maxRetries=2 but process config has maxRetries=3
      const record = createRecord({ retryCount: 1, maxRetries: 2 });
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      transport.dispatch.mockRejectedValue(new Error('fail'));
      const handler = {
        instance: {},
        methodName: 'handle',
        eventTypes: ['order.created'],
      };
      const explorer = createMockExplorer({ 'order.created': [handler] });

      const poller = createPoller({
        prisma,
        transport,
        explorer,
        options: { retry: { maxRetries: 10 } }, // process config says 10
      });
      await poller.poll();

      // Should use record.maxRetries (2), not process config (10)
      // retryCount=1, newRetryCount=2, record.maxRetries=2 → FAILED
      const call = prisma.$executeRaw.mock.calls[0];
      const sqlStrings = call[0].join('');
      expect(sqlStrings).toContain('FAILED');
    });

    it('should call dispatch lifecycle hooks around successful delivery', async () => {
      const record = createRecord({
        tenantId: 'tenant-1',
        correlationId: 'corr-1',
      });
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      const handler = {
        instance: {},
        methodName: 'handle',
        eventTypes: ['order.created'],
      };
      const explorer = createMockExplorer({ 'order.created': [handler] });
      const hooks = {
        onPollStart: jest.fn(),
        onDispatchStart: jest.fn(),
        onDispatchSuccess: jest.fn(),
      };

      const poller = createPoller({
        prisma,
        transport,
        explorer,
        options: { hooks },
      });
      await poller.poll();

      expect(hooks.onPollStart).toHaveBeenCalledWith(
        expect.objectContaining({ batchSize: 10 }),
      );
      expect(hooks.onDispatchStart).toHaveBeenCalledWith(
        expect.objectContaining({
          record: publicRecord(record),
          tenantId: 'tenant-1',
          correlationId: 'corr-1',
        }),
      );
      expect(hooks.onDispatchSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          record: publicRecord(record),
          tenantId: 'tenant-1',
          durationMs: expect.any(Number),
        }),
      );
    });

    it('should isolate hook errors from delivery state', async () => {
      const record = createRecord();
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      const handler = {
        instance: {},
        methodName: 'handle',
        eventTypes: ['order.created'],
      };
      const explorer = createMockExplorer({ 'order.created': [handler] });

      const poller = createPoller({
        prisma,
        transport,
        explorer,
        options: {
          hooks: {
            onDispatchStart: jest
              .fn()
              .mockRejectedValue(new Error('hook failed')),
          },
        },
      });
      await poller.poll();

      expect(transport.dispatch).toHaveBeenCalled();
      const sql = prisma.$executeRaw.mock.calls[0][0].join('');
      expect(sql).toContain('SENT');
    });

    it('should call retry hook on retriable failures', async () => {
      const record = createRecord({ retryCount: 1, maxRetries: 5 });
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      transport.dispatch.mockRejectedValue(new Error('handler failed'));
      const handler = {
        instance: {},
        methodName: 'handle',
        eventTypes: ['order.created'],
      };
      const explorer = createMockExplorer({ 'order.created': [handler] });
      const hooks = {
        onDispatchFailure: jest.fn(),
        onRetryScheduled: jest.fn(),
        onDeadLetter: jest.fn(),
      };

      const poller = createPoller({
        prisma,
        transport,
        explorer,
        options: { hooks },
      });
      await poller.poll();

      expect(hooks.onDispatchFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(Error),
          durationMs: expect.any(Number),
        }),
      );
      expect(hooks.onRetryScheduled).toHaveBeenCalledWith(
        expect.objectContaining({
          record: publicRecord(record),
          retryCount: 2,
          maxRetries: 5,
        }),
      );
      expect(hooks.onDeadLetter).not.toHaveBeenCalled();
    });

    it('should call dead-letter hook when max retries are exhausted', async () => {
      const record = createRecord({ retryCount: 2, maxRetries: 3 });
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      transport.dispatch.mockRejectedValue(new Error('still failing'));
      const handler = {
        instance: {},
        methodName: 'handle',
        eventTypes: ['order.created'],
      };
      const explorer = createMockExplorer({ 'order.created': [handler] });
      const hooks = {
        onDeadLetter: jest.fn(),
      };

      const poller = createPoller({
        prisma,
        transport,
        explorer,
        options: { hooks },
      });
      await poller.poll();

      expect(hooks.onDeadLetter).toHaveBeenCalledWith(
        expect.objectContaining({
          record: publicRecord(record),
          retryCount: 3,
          maxRetries: 3,
        }),
      );
    });
  });

  describe('onApplicationShutdown', () => {
    it('should delete interval from SchedulerRegistry', async () => {
      const schedulerRegistry = createMockSchedulerRegistry();
      const poller = createPoller({ schedulerRegistry });

      await poller.onApplicationShutdown();

      expect(schedulerRegistry.deleteInterval).toHaveBeenCalledWith(
        'outbox-poll',
      );
    });

    it('should not throw if interval was not registered', async () => {
      const schedulerRegistry = createMockSchedulerRegistry();
      schedulerRegistry.deleteInterval.mockImplementation(() => {
        throw new Error('No Interval was found');
      });

      const poller = createPoller({ schedulerRegistry });
      await expect(poller.onApplicationShutdown()).resolves.toBeUndefined();
    });

    it('should wait for in-flight poll to complete before exiting', async () => {
      let resolveFetchAndLock: () => void;
      const fetchAndLockPromise = new Promise<void>((resolve) => {
        resolveFetchAndLock = resolve;
      });

      const prisma = {
        $queryRaw: jest.fn().mockImplementation(() => {
          // Simulate a slow fetchAndLock
          return fetchAndLockPromise.then(() => []);
        }),
        $executeRaw: jest.fn().mockResolvedValue(1),
      };

      const poller = createPoller({ prisma });

      // Start poll (it will block on fetchAndLock)
      const pollPromise = poller.poll();

      // Start shutdown while poll is in-flight
      const shutdownPromise = poller.onApplicationShutdown();

      // Shutdown should NOT have resolved yet (poll is still running)
      let shutdownDone = false;
      shutdownPromise.then(() => {
        shutdownDone = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(shutdownDone).toBe(false);

      // Now let fetchAndLock complete
      resolveFetchAndLock!();
      await pollPromise;
      await shutdownPromise;
      expect(shutdownDone).toBe(true);
    });

    it('drops a queued rerun while waiting for the in-flight poll', async () => {
      let releaseFetch!: () => void;
      const fetchBarrier = new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      const prisma = createMockPrisma();
      prisma.$queryRaw.mockImplementation(async () => {
        await fetchBarrier;
        return [];
      });
      const poller = createPoller({ prisma });

      const inFlight = poller.poll();
      await Promise.resolve();
      const queued = poller.poll();
      const shutdown = poller.onApplicationShutdown();

      releaseFetch();
      await Promise.all([inFlight, queued, shutdown]);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('keeps a publisher rejection retriable when shutdown starts during dispatch', async () => {
      const record = createRecord({ retryCount: 0, maxRetries: 3 });
      const prisma = createMockPrisma([record]);
      let reportDispatchStarted!: () => void;
      const dispatchStarted = new Promise<void>((resolve) => {
        reportDispatchStarted = resolve;
      });
      let rejectDispatch!: (error: Error) => void;
      const dispatchBarrier = new Promise<never>((_, reject) => {
        rejectDispatch = reject;
      });
      const publisher = {
        publish: jest.fn(async () => {
          reportDispatchStarted();
          return dispatchBarrier;
        }),
      };
      const poller = createPoller({
        prisma,
        transport: publisher,
        options: {
          delivery: { mode: 'publisher' },
          retry: { maxRetries: 3, backoff: 'fixed', initialDelay: 100 },
        },
      });

      const polling = poller.poll();
      await dispatchStarted;
      const shutdown = poller.onApplicationShutdown();
      rejectDispatch(new Error('publisher closed during shutdown'));
      await Promise.all([polling, shutdown]);

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const [sql, ...values] = prisma.$executeRaw.mock.calls[0];
      expect(sql.join('')).toContain("SET status = 'PENDING'");
      expect(sql.join('')).toContain('next_attempt_at = NOW()');
      expect(sql.join('')).not.toContain("SET status = 'FAILED'");
      expect(values).toEqual(
        expect.arrayContaining([1, record.id, record.claimToken]),
      );
    });

    it.each([0, 1])(
      'releases a claim fetched after shutdown starts without dispatching it (CAS rows=%i)',
      async (rows) => {
        const record = createRecord();
        let releaseFetch!: () => void;
        const fetchBarrier = new Promise<void>((resolve) => {
          releaseFetch = resolve;
        });
        const prisma = createMockPrisma();
        prisma.$queryRaw.mockImplementation(async () => {
          await fetchBarrier;
          return [record];
        });
        const publisher = { publish: jest.fn().mockResolvedValue(undefined) };
        const poller = createPoller({
          prisma,
          transport: publisher,
          options: { delivery: { mode: 'publisher' } },
        });

        prisma.$executeRaw.mockResolvedValue(rows);
        const inFlight = poller.poll();
        const shutdown = poller.onApplicationShutdown();
        releaseFetch();
        await Promise.all([inFlight, shutdown]);

        expect(publisher.publish).not.toHaveBeenCalled();
        expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
        const releaseSql = prisma.$executeRaw.mock.calls[0][0].join('');
        expect(releaseSql).toContain("SET status = 'PENDING'");
        expect(releaseSql).toContain('claim_token = NULL');
        expect(releaseSql).toContain('lease_expires_at = NULL');
      },
    );
  });

  describe('lease option invariants', () => {
    it('uses stuckThreshold as a compatibility alias for lease duration', async () => {
      const prisma = createMockPrisma([createRecord()]);
      const poller = createPoller({
        prisma,
        transport: { publish: jest.fn().mockResolvedValue(undefined) },
        options: {
          delivery: { mode: 'publisher' },
          stuckThreshold: 120,
        },
      });

      await poller.poll();

      const [, ...claimValues] = prisma.$queryRaw.mock.calls[0];
      expect(claimValues).toContain(0.12);
    });

    it('prefers explicit lease duration over stuckThreshold', async () => {
      const prisma = createMockPrisma([createRecord()]);
      const poller = createPoller({
        prisma,
        transport: { publish: jest.fn().mockResolvedValue(undefined) },
        options: {
          delivery: { mode: 'publisher' },
          stuckThreshold: 120,
          lease: { duration: 300, heartbeatInterval: 100 },
        },
      });

      await poller.poll();

      const [, ...claimValues] = prisma.$queryRaw.mock.calls[0];
      expect(claimValues).toContain(0.3);
      expect(claimValues).not.toContain(0.12);
    });

    it.each([
      {
        lease: { duration: 0 },
        message: 'lease.duration must be a positive finite number',
      },
      {
        lease: { duration: 100, heartbeatInterval: 50 },
        message:
          'lease.heartbeatInterval must be positive and less than lease.duration / 2',
      },
      {
        lease: { heartbeatFailureTolerance: -1 },
        message:
          'lease.heartbeatFailureTolerance must be a non-negative integer',
      },
    ])('rejects invalid $message', ({ lease, message }) => {
      expect(() =>
        createPoller({ options: { lease } as Partial<OutboxOptions> }),
      ).toThrow(message);
    });
  });

  describe('retry option invariants', () => {
    it.each([
      [
        { initialDelay: -1 },
        'retry.initialDelay must be a non-negative safe integer',
      ],
      [{ maxDelay: 0 }, 'retry.maxDelay must be a positive safe integer'],
      [
        { initialDelay: 2_000, maxDelay: 1_000 },
        'retry.initialDelay must be less than or equal to retry.maxDelay',
      ],
    ])('rejects invalid retry options %j', (retry, message) => {
      expect(() =>
        createPoller({
          options: {
            retry: {
              maxRetries: 5,
              backoff: 'exponential',
              ...retry,
            },
          },
        }),
      ).toThrow(message);
    });
  });
});
