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
  describe('onModuleInit', () => {
    it('should register interval with SchedulerRegistry', () => {
      const schedulerRegistry = createMockSchedulerRegistry();
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

    it('should mark event as SENT when no handlers exist', async () => {
      const record = createRecord();
      const prisma = createMockPrisma([record]);
      const explorer = createMockExplorer({});

      const poller = createPoller({ prisma, explorer });
      await poller.poll();

      expect(prisma.$executeRaw).toHaveBeenCalled();
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
