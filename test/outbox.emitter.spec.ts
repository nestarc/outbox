import { OutboxEmitter } from '../src/outbox.emitter';
import { OutboxEvent } from '../src/outbox.event';
import type { OutboxOptions } from '../src/interfaces/outbox-options.interface';

class OrderCreatedEvent extends OutboxEvent {
  static readonly eventType = 'order.created';

  constructor(
    public readonly orderId: string,
    public readonly total: number,
  ) {
    super();
  }
}

class OrderPaidEvent extends OutboxEvent {
  static readonly eventType = 'order.paid';

  constructor(public readonly orderId: string) {
    super();
  }
}

function createMockTx() {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn(),
  };
}

function createEmitter(overrides?: Partial<OutboxOptions>): OutboxEmitter {
  const options: OutboxOptions = {
    prisma: {},
    retry: { maxRetries: 5 },
    ...overrides,
  };
  return new OutboxEmitter(options);
}

describe('OutboxEmitter', () => {
  describe('emit', () => {
    it('should call $executeRaw with event type and payload', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();
      const event = new OrderCreatedEvent('order-1', 99.99);

      await emitter.emit(tx, event);

      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = tx.$executeRaw.mock.calls[0];
      expect(values[0]).toBe('order.created');
      expect(values[1]).toBe(JSON.stringify({ orderId: 'order-1', total: 99.99 }));
      expect(values[2]).toBe(5); // maxRetries
    });

    it('should use custom maxRetries from options', async () => {
      const emitter = createEmitter({ retry: { maxRetries: 10 } });
      const tx = createMockTx();

      await emitter.emit(tx, new OrderCreatedEvent('order-1', 50));

      const [, , , maxRetries] = tx.$executeRaw.mock.calls[0];
      expect(maxRetries).toBe(10);
    });

    it('should use default maxRetries when not specified', async () => {
      const emitter = createEmitter({ retry: undefined });
      const tx = createMockTx();

      await emitter.emit(tx, new OrderCreatedEvent('order-1', 50));

      const [, , , maxRetries] = tx.$executeRaw.mock.calls[0];
      expect(maxRetries).toBe(5);
    });
  });

  describe('emitMany', () => {
    it('should call $executeRaw once per event', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();

      await emitter.emitMany(tx, [
        new OrderCreatedEvent('order-1', 100),
        new OrderPaidEvent('order-1'),
      ]);

      expect(tx.$executeRaw).toHaveBeenCalledTimes(2);

      const firstCallValues = tx.$executeRaw.mock.calls[0].slice(1);
      expect(firstCallValues[0]).toBe('order.created');

      const secondCallValues = tx.$executeRaw.mock.calls[1].slice(1);
      expect(secondCallValues[0]).toBe('order.paid');
    });

    it('should handle empty array', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();

      await emitter.emitMany(tx, []);

      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });
  });
});
