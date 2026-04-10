import { OutboxPoller } from '../src/outbox.poller';
import type { OutboxOptions } from '../src/interfaces/outbox-options.interface';
import type { OutboxTransport } from '../src/interfaces/outbox-transport.interface';
import type { OutboxRecord } from '../src/interfaces/outbox-record.interface';
import type { OutboxExplorer } from '../src/outbox.explorer';
import type { SchedulerRegistry } from '@nestjs/schedule';

function createRecord(overrides?: Partial<OutboxRecord>): OutboxRecord {
  return {
    id: 'evt-1',
    eventType: 'order.created',
    payload: { orderId: 'order-1' },
    status: 'PROCESSING',
    createdAt: new Date(),
    updatedAt: new Date(),
    processedAt: null,
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    tenantId: null,
    ...overrides,
  };
}

function createMockPrisma(records: OutboxRecord[] = []) {
  return {
    $queryRaw: jest.fn().mockResolvedValue(records),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
}

function createMockTransport(): jest.Mocked<OutboxTransport> {
  return { dispatch: jest.fn().mockResolvedValue(undefined) };
}

function createMockExplorer(
  handlerMap: Record<string, any[]> = {},
): jest.Mocked<Pick<OutboxExplorer, 'getHandlers' | 'getRegisteredEventTypes'>> {
  return {
    getHandlers: jest.fn((eventType: string) => handlerMap[eventType] ?? []),
    getRegisteredEventTypes: jest.fn(() => Object.keys(handlerMap)),
  };
}

function createMockSchedulerRegistry(): jest.Mocked<Pick<SchedulerRegistry, 'addInterval' | 'deleteInterval'>> {
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
  });

  describe('poll', () => {
    it('should fetch events and dispatch to transport', async () => {
      const record = createRecord();
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      const handler = { instance: {}, methodName: 'handle', eventTypes: ['order.created'] };
      const explorer = createMockExplorer({ 'order.created': [handler] });

      const poller = createPoller({ prisma, transport, explorer });
      await poller.poll();

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(transport.dispatch).toHaveBeenCalledWith(record, [handler]);
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

    it('should handle transport failure and increment retry count', async () => {
      const record = createRecord({ retryCount: 0 });
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      transport.dispatch.mockRejectedValue(new Error('handler failed'));
      const handler = { instance: {}, methodName: 'handle', eventTypes: ['order.created'] };
      const explorer = createMockExplorer({ 'order.created': [handler] });

      const poller = createPoller({ prisma, transport, explorer });
      await poller.poll();

      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it('should mark as FAILED when max retries exceeded', async () => {
      const record = createRecord({ retryCount: 2, maxRetries: 3 });
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      transport.dispatch.mockRejectedValue(new Error('still failing'));
      const handler = { instance: {}, methodName: 'handle', eventTypes: ['order.created'] };
      const explorer = createMockExplorer({ 'order.created': [handler] });

      const poller = createPoller({
        prisma,
        transport,
        explorer,
        options: { retry: { maxRetries: 3 } },
      });
      await poller.poll();

      const executeRawCalls = prisma.$executeRaw.mock.calls;
      expect(executeRawCalls.length).toBeGreaterThan(0);
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
    });

    it('should use record.maxRetries for failure threshold', async () => {
      // Record has maxRetries=2 but process config has maxRetries=3
      const record = createRecord({ retryCount: 1, maxRetries: 2 });
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      transport.dispatch.mockRejectedValue(new Error('fail'));
      const handler = { instance: {}, methodName: 'handle', eventTypes: ['order.created'] };
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
  });

  describe('onApplicationShutdown', () => {
    it('should delete interval from SchedulerRegistry', async () => {
      const schedulerRegistry = createMockSchedulerRegistry();
      const poller = createPoller({ schedulerRegistry });

      await poller.onApplicationShutdown();

      expect(schedulerRegistry.deleteInterval).toHaveBeenCalledWith('outbox-poll');
    });

    it('should not throw if interval was not registered', async () => {
      const schedulerRegistry = createMockSchedulerRegistry();
      schedulerRegistry.deleteInterval.mockImplementation(() => {
        throw new Error('No Interval was found');
      });

      const poller = createPoller({ schedulerRegistry });
      await expect(poller.onApplicationShutdown()).resolves.toBeUndefined();
    });
  });
});
