import { LocalTransport } from '../src/transports/local.transport';
import type { OutboxRecord } from '../src/interfaces/outbox-record.interface';
import type { OutboxHandler } from '../src/interfaces/outbox-handler.interface';

function createRecord(overrides?: Partial<OutboxRecord>): OutboxRecord {
  return {
    id: 'record-1',
    eventType: 'order.created',
    payload: { orderId: 'order-1', total: 100 },
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

    expect(handler1.instance.handle1).toHaveBeenCalledWith(record.payload);
    expect(handler2.instance.handle2).toHaveBeenCalledWith(record.payload);
    expect(callOrder).toEqual(['handler1', 'handler2']);
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
