import { OutboxExplorer } from '../src/outbox.explorer';
import { OUTBOX_EVENT_METADATA } from '../src/outbox.constants';
import type { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type { Reflector } from '@nestjs/core';

class FakeHandler {
  handleOrder() {}
  handlePayment() {}
  notDecorated() {}
}

function createExplorer(handlers: { instance: any; methodMetadata: Record<string, string[]> }[]) {
  const wrappers = handlers.map((h) => ({
    instance: h.instance,
    metatype: h.instance.constructor,
    token: h.instance.constructor,
    name: h.instance.constructor.name,
    isAlias: false,
  }));

  const mockDiscovery: Partial<DiscoveryService> = {
    getProviders: jest.fn().mockReturnValue(wrappers),
  };

  const mockScanner: Partial<MetadataScanner> = {
    getAllMethodNames: jest.fn((prototype: any) => {
      return Object.getOwnPropertyNames(prototype).filter(
        (name) => name !== 'constructor' && typeof prototype[name] === 'function',
      );
    }),
  };

  const mockReflector: Partial<Reflector> = {
    get: jest.fn((key: any, target: any) => {
      const handler = handlers.find((h) => {
        const proto = Object.getPrototypeOf(h.instance);
        return Object.values(proto).includes(target) ||
          Object.getOwnPropertyNames(proto).some((m) => proto[m] === target);
      });
      if (!handler) return undefined;
      const methodName = Object.getOwnPropertyNames(Object.getPrototypeOf(handler.instance))
        .find((m) => Object.getPrototypeOf(handler.instance)[m] === target);
      if (!methodName) return undefined;
      return handler.methodMetadata[methodName];
    }),
  };

  return new OutboxExplorer(
    mockDiscovery as DiscoveryService,
    mockScanner as MetadataScanner,
    mockReflector as Reflector,
  );
}

describe('OutboxExplorer', () => {
  it('should discover handlers and build eventType → handler map', () => {
    const instance = new FakeHandler();
    const explorer = createExplorer([
      {
        instance,
        methodMetadata: {
          handleOrder: ['order.created'],
          handlePayment: ['payment.completed'],
        },
      },
    ]);

    explorer.onModuleInit();

    const orderHandlers = explorer.getHandlers('order.created');
    expect(orderHandlers).toHaveLength(1);
    expect(orderHandlers[0].instance).toBe(instance);
    expect(orderHandlers[0].methodName).toBe('handleOrder');

    const paymentHandlers = explorer.getHandlers('payment.completed');
    expect(paymentHandlers).toHaveLength(1);
    expect(paymentHandlers[0].methodName).toBe('handlePayment');
  });

  it('should return empty array for unregistered event types', () => {
    const explorer = createExplorer([]);
    explorer.onModuleInit();

    expect(explorer.getHandlers('nonexistent')).toEqual([]);
  });

  it('should support multiple handlers for the same event type', () => {
    const instance1 = new FakeHandler();
    const instance2 = new FakeHandler();

    const explorer = createExplorer([
      { instance: instance1, methodMetadata: { handleOrder: ['order.created'] } },
      { instance: instance2, methodMetadata: { handleOrder: ['order.created'] } },
    ]);

    explorer.onModuleInit();

    const handlers = explorer.getHandlers('order.created');
    expect(handlers).toHaveLength(2);
  });

  it('should list all registered event types', () => {
    const explorer = createExplorer([
      {
        instance: new FakeHandler(),
        methodMetadata: {
          handleOrder: ['order.created'],
          handlePayment: ['payment.completed'],
        },
      },
    ]);

    explorer.onModuleInit();

    const types = explorer.getRegisteredEventTypes();
    expect(types).toContain('order.created');
    expect(types).toContain('payment.completed');
    expect(types).toHaveLength(2);
  });

  it('should skip providers without instances', () => {
    const mockDiscovery: Partial<DiscoveryService> = {
      getProviders: jest.fn().mockReturnValue([{ instance: null }]),
    };
    const mockScanner: Partial<MetadataScanner> = {
      getAllMethodNames: jest.fn().mockReturnValue([]),
    };
    const mockReflector: Partial<Reflector> = {
      get: jest.fn(),
    };

    const explorer = new OutboxExplorer(
      mockDiscovery as DiscoveryService,
      mockScanner as MetadataScanner,
      mockReflector as Reflector,
    );

    expect(() => explorer.onModuleInit()).not.toThrow();
    expect(explorer.getRegisteredEventTypes()).toEqual([]);
  });
});
