import { LocalTransport } from '../src/transports/local.transport';
import type { OutboxRecord } from '../src/interfaces/outbox-record.interface';
import type { OutboxHandler } from '../src/interfaces/outbox-handler.interface';
import type { OutboxHandlerContext } from '../src/interfaces/outbox-handler-context.interface';
import type { OutboxTenantProvider } from '../src/interfaces/outbox-tenancy.interface';

function createRecord(overrides?: Partial<OutboxRecord>): OutboxRecord {
  return {
    id: 'record-1',
    eventType: 'order.created',
    payload: { orderId: 'order-1', total: 100 },
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
    ...overrides,
  };
}

describe('LocalTransport', () => {
  let transport: LocalTransport;

  beforeEach(() => {
    transport = new LocalTransport();
  });

  it('should call each handler sequentially with the payload', async () => {
    const callOrder: string[] = [];
    const handler1: OutboxHandler = {
      instance: {
        handle1: jest.fn(async () => {
          callOrder.push('handler1');
        }),
      },
      methodName: 'handle1',
      eventTypes: ['order.created'],
    };
    const handler2: OutboxHandler = {
      instance: {
        handle2: jest.fn(async () => {
          callOrder.push('handler2');
        }),
      },
      methodName: 'handle2',
      eventTypes: ['order.created'],
    };

    const record = createRecord();
    await transport.dispatch(record, [handler1, handler2]);

    expect(handler1.instance.handle1).toHaveBeenCalledWith(
      record.payload,
      expect.objectContaining({ eventId: record.id }),
    );
    expect(handler2.instance.handle2).toHaveBeenCalledWith(
      record.payload,
      expect.objectContaining({ eventId: record.id }),
    );
    expect(callOrder).toEqual(['handler1', 'handler2']);
  });

  it('gives each handler a detached deep record snapshot', async () => {
    const observed: Array<{ id: string; nestedId: string }> = [];
    const handler1: OutboxHandler = {
      instance: {
        handle: jest.fn(
          async (
            payload: Readonly<Record<string, unknown>>,
            context: OutboxHandlerContext,
          ) => {
            const mutablePayload = payload as {
              nested: { id: string };
            };
            const mutableRecord = context.record as unknown as { id: string };
            mutablePayload.nested.id = 'mutated';
            mutableRecord.id = 'mutated';
          },
        ),
      },
      methodName: 'handle',
      eventTypes: ['order.created'],
    };
    const handler2: OutboxHandler = {
      instance: {
        handle: jest.fn(
          async (
            payload: Readonly<Record<string, unknown>>,
            context: OutboxHandlerContext,
          ) => {
            observed.push({
              id: context.record.id,
              nestedId: (payload.nested as { id: string }).id,
            });
          },
        ),
      },
      methodName: 'handle',
      eventTypes: ['order.created'],
    };
    const record = createRecord({ payload: { nested: { id: 'original' } } });

    await transport.dispatch(record, [handler1, handler2]);

    expect(observed).toEqual([{ id: 'record-1', nestedId: 'original' }]);
    expect(record).toEqual(
      expect.objectContaining({
        id: 'record-1',
        payload: { nested: { id: 'original' } },
      }),
    );
  });

  it('should pass metadata context as the second handler argument', async () => {
    const handler: OutboxHandler = {
      instance: {
        handle: jest.fn(),
      },
      methodName: 'handle',
      eventTypes: ['order.created'],
    };
    const record = createRecord({
      tenantId: 'tenant-1',
      retryCount: 2,
      headers: { correlation: 'corr-1' },
      correlationId: 'corr-1',
    });

    await transport.dispatch(record, [handler]);

    expect(handler.instance.handle).toHaveBeenCalledWith(
      record.payload,
      expect.objectContaining<Partial<OutboxHandlerContext>>({
        record,
        eventId: record.id,
        eventType: 'order.created',
        tenantId: 'tenant-1',
        retryCount: 2,
        headers: { correlation: 'corr-1' },
      }),
    );
  });

  it('should restore tenant context when a tenant provider supports runWithTenant', async () => {
    const runWithTenant = jest.fn();
    const tenantProvider: OutboxTenantProvider = {
      runWithTenant: async <T>(tenantId: string, fn: () => Promise<T>) => {
        runWithTenant(tenantId, fn);
        return fn();
      },
    };
    transport = new LocalTransport(tenantProvider);
    const handler: OutboxHandler = {
      instance: {
        handle: jest.fn(),
      },
      methodName: 'handle',
      eventTypes: ['order.created'],
    };
    const record = createRecord({ tenantId: 'tenant-1' });

    await transport.dispatch(record, [handler]);

    expect(runWithTenant).toHaveBeenCalledWith(
      'tenant-1',
      expect.any(Function),
    );
    expect(handler.instance.handle).toHaveBeenCalled();
  });

  it('should abort on first failure (all-or-nothing)', async () => {
    const handler1: OutboxHandler = {
      instance: {
        handle: jest.fn().mockRejectedValue(new Error('handler1 failed')),
      },
      methodName: 'handle',
      eventTypes: ['order.created'],
    };
    const handler2: OutboxHandler = {
      instance: { handle: jest.fn() },
      methodName: 'handle',
      eventTypes: ['order.created'],
    };

    const record = createRecord();
    await expect(
      transport.dispatch(record, [handler1, handler2]),
    ).rejects.toThrow('handler1 failed');

    expect(handler2.instance.handle).not.toHaveBeenCalled();
  });

  it('should resolve immediately for empty handlers', async () => {
    const record = createRecord();
    await expect(transport.dispatch(record, [])).resolves.toBeUndefined();
  });
});
