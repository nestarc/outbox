import { OutboxEmitter } from '../src/outbox.emitter';
import { OutboxEvent } from '../src/outbox.event';
import type { OutboxEmitOptions } from '../src/interfaces/outbox-emit-options.interface';
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

class PayloadEvent extends OutboxEvent {
  static readonly eventType = 'payload.test';

  constructor(private readonly value: Record<string, unknown>) {
    super();
  }

  override toPayload(): Record<string, unknown> {
    return this.value;
  }
}

function createMockTx() {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
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
      const [, ...values] = tx.$executeRaw.mock.calls[0];
      expect(values[0]).toBe('order.created');
      expect(values[1]).toBe(
        JSON.stringify({ orderId: 'order-1', total: 99.99 }),
      );
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

    it('should insert stable metadata and explicit tenant id', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();
      const occurredAt = new Date('2026-01-02T03:04:05.000Z');

      await emitter.emit(tx, new OrderCreatedEvent('order-1', 99.99), {
        tenantId: 'tenant-1',
        aggregateType: 'Order',
        aggregateId: 'order-1',
        partitionKey: 'order-1',
        idempotencyKey: 'idem-1',
        correlationId: 'corr-1',
        causationId: 'cause-1',
        headers: { source: 'api' },
        occurredAt,
      });

      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = tx.$executeRaw.mock.calls[0];
      expect(strings.join('')).toContain('aggregate_type');
      expect(strings.join('')).toContain('occurred_at');
      expect(values).toEqual([
        'order.created',
        JSON.stringify({ orderId: 'order-1', total: 99.99 }),
        5,
        'tenant-1',
        'Order',
        'order-1',
        'order-1',
        'idem-1',
        'corr-1',
        'cause-1',
        JSON.stringify({ source: 'api' }),
        occurredAt,
      ]);
    });

    it('should default optional metadata to null and empty headers', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();

      await emitter.emit(tx, new OrderCreatedEvent('order-1', 50));

      const [, ...values] = tx.$executeRaw.mock.calls[0];
      expect(values.slice(3)).toEqual([
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        JSON.stringify({}),
        null,
      ]);
    });

    it('should use tenancy provider tenant id when explicit tenant id is absent', async () => {
      const tenantProvider = {
        getTenantId: jest.fn().mockReturnValue('tenant-from-provider'),
      };
      const emitter = createEmitter({ tenancy: { provider: tenantProvider } });
      const tx = createMockTx();

      await emitter.emit(tx, new OrderCreatedEvent('order-1', 50));

      const [, ...values] = tx.$executeRaw.mock.calls[0];
      expect(values[3]).toBe('tenant-from-provider');
    });

    it('should use tenancy provider tenant id when explicit tenant id is undefined', async () => {
      const tenantProvider = {
        getTenantId: jest.fn().mockReturnValue('tenant-from-provider'),
      };
      const emitter = createEmitter({ tenancy: { provider: tenantProvider } });
      const tx = createMockTx();

      await emitter.emit(tx, new OrderCreatedEvent('order-1', 50), {
        tenantId: undefined,
      });

      const [, ...values] = tx.$executeRaw.mock.calls[0];
      expect(values[3]).toBe('tenant-from-provider');
    });

    it('should prefer explicit tenant id over tenancy provider tenant id', async () => {
      const tenantProvider = {
        getTenantId: jest.fn().mockReturnValue('tenant-from-provider'),
      };
      const emitter = createEmitter({ tenancy: { provider: tenantProvider } });
      const tx = createMockTx();

      await emitter.emit(tx, new OrderCreatedEvent('order-1', 50), {
        tenantId: 'tenant-explicit',
      });

      const [, ...values] = tx.$executeRaw.mock.calls[0];
      expect(values[3]).toBe('tenant-explicit');
      expect(tenantProvider.getTenantId).not.toHaveBeenCalled();
    });

    it('should store a deliberate global event without consulting the provider', async () => {
      const tenantProvider = {
        getTenantId: jest.fn().mockReturnValue('tenant-from-provider'),
      };
      const emitter = createEmitter({
        tenancy: { provider: tenantProvider, policy: 'required' },
      });
      const tx = createMockTx();

      await emitter.emit(tx, new OrderCreatedEvent('order-1', 50), {
        tenantScope: 'global',
      });

      const [, ...values] = tx.$executeRaw.mock.calls[0];
      expect(values[3]).toBeNull();
      expect(tenantProvider.getTenantId).not.toHaveBeenCalled();
    });

    it('should reject null tenant id in favor of the explicit global scope', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();
      const options = { tenantId: null } as unknown as OutboxEmitOptions;

      await expect(
        emitter.emit(tx, new OrderCreatedEvent('order-1', 50), options),
      ).rejects.toThrow(
        'Outbox tenantId cannot be null; use tenantScope: "global" for a global event',
      );
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it.each(['', '   ', ' tenant-1', 'tenant-1 '])(
      'should reject non-canonical explicit tenant id %p before inserting',
      async (tenantId) => {
        const emitter = createEmitter();
        const tx = createMockTx();

        await expect(
          emitter.emit(tx, new OrderCreatedEvent('order-1', 50), {
            tenantId,
          }),
        ).rejects.toThrow(
          'Outbox explicit tenantId must be non-empty and have no leading or trailing whitespace',
        );
        expect(tx.$executeRaw).not.toHaveBeenCalled();
      },
    );

    it('should reject a non-string explicit tenant id before inserting', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();
      const options = { tenantId: 42 } as unknown as OutboxEmitOptions;

      await expect(
        emitter.emit(tx, new OrderCreatedEvent('order-1', 50), options),
      ).rejects.toThrow('Outbox explicit tenantId must be a string');
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('should reject an invalid provider tenant id before inserting', async () => {
      const tenantProvider = {
        getTenantId: jest.fn().mockReturnValue(' tenant-1'),
      };
      const emitter = createEmitter({ tenancy: { provider: tenantProvider } });
      const tx = createMockTx();

      await expect(
        emitter.emit(tx, new OrderCreatedEvent('order-1', 50)),
      ).rejects.toThrow(
        'Outbox provider tenantId must be non-empty and have no leading or trailing whitespace',
      );
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('should require a tenant under the required policy', async () => {
      const emitter = createEmitter({ tenancy: { policy: 'required' } });
      const tx = createMockTx();

      await expect(
        emitter.emit(tx, new OrderCreatedEvent('order-1', 50)),
      ).rejects.toThrow(
        'Outbox tenancy policy "required" requires a tenantId or tenantScope: "global"',
      );
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('should accept matching explicit and provider tenant ids', async () => {
      const tenantProvider = {
        getTenantId: jest.fn().mockReturnValue('tenant-1'),
      };
      const emitter = createEmitter({
        tenancy: { provider: tenantProvider, policy: 'require-match' },
      });
      const tx = createMockTx();

      await emitter.emit(tx, new OrderCreatedEvent('order-1', 50), {
        tenantId: 'tenant-1',
      });

      const [, ...values] = tx.$executeRaw.mock.calls[0];
      expect(values[3]).toBe('tenant-1');
      expect(tenantProvider.getTenantId).toHaveBeenCalledTimes(1);
    });

    it('should fail closed when explicit and provider tenant ids differ', async () => {
      const tenantProvider = {
        getTenantId: jest.fn().mockReturnValue('tenant-provider'),
      };
      const emitter = createEmitter({
        tenancy: { provider: tenantProvider, policy: 'require-match' },
      });
      const tx = createMockTx();

      await expect(
        emitter.emit(tx, new OrderCreatedEvent('order-1', 50), {
          tenantId: 'tenant-explicit',
        }),
      ).rejects.toThrow(
        'Outbox explicit tenantId does not match the provider tenantId',
      );
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('should require provider provenance for an explicit require-match tenant', async () => {
      const emitter = createEmitter({ tenancy: { policy: 'require-match' } });
      const tx = createMockTx();

      await expect(
        emitter.emit(tx, new OrderCreatedEvent('order-1', 50), {
          tenantId: 'tenant-1',
        }),
      ).rejects.toThrow(
        'Outbox tenancy policy "require-match" requires a provider tenantId',
      );
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('should call onEmit hook and isolate hook errors', async () => {
      const hooks = {
        onEmit: jest.fn().mockRejectedValue(new Error('metrics down')),
      };
      const emitter = createEmitter({ hooks });
      const tx = createMockTx();

      await expect(
        emitter.emit(tx, new OrderCreatedEvent('order-1', 50), {
          correlationId: 'corr-1',
        }),
      ).resolves.toBeUndefined();

      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(hooks.onEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'order.created',
          tenantId: null,
          correlationId: 'corr-1',
          headers: {},
        }),
      );
    });

    it('observes an attempted emit before a caller-owned transaction rolls back', async () => {
      const observations: string[] = [];
      const emitter = createEmitter({
        hooks: {
          onEmit: jest.fn(() => {
            observations.push('onEmit');
          }),
        },
      });
      const tx = createMockTx();

      await expect(
        (async () => {
          await emitter.emit(tx, new OrderCreatedEvent('order-rollback', 50));
          throw new Error('caller rolled back');
        })(),
      ).rejects.toThrow('caller rolled back');

      expect(observations).toEqual(['onEmit']);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('gives onEmit a detached deep snapshot of caller-owned values', async () => {
      const payload = { order: { id: 'order-1' } };
      const headers = { source: 'api' };
      const occurredAt = new Date('2026-01-02T03:04:05.000Z');
      const emitter = createEmitter({
        hooks: {
          onEmit: jest.fn((context) => {
            const mutable = context as unknown as {
              payload: { order: { id: string } };
              headers: { source: string };
              occurredAt: Date;
            };
            mutable.payload.order.id = 'mutated';
            mutable.headers.source = 'mutated';
            mutable.occurredAt.setUTCFullYear(1999);
          }),
        },
      });

      await emitter.emit(createMockTx(), new PayloadEvent(payload), {
        headers,
        occurredAt,
      });

      expect(payload).toEqual({ order: { id: 'order-1' } });
      expect(headers).toEqual({ source: 'api' });
      expect(occurredAt.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    });

    it.each([
      ['BigInt', { value: 1n }],
      ['Invalid Date', { value: new Date('invalid') }],
      ['non-plain object', { value: new Map([['key', 'value']]) }],
    ])(
      'rejects %s payloads with a stable package error',
      async (_, payload) => {
        const emitter = createEmitter();
        const tx = createMockTx();

        await expect(
          emitter.emit(tx, new PayloadEvent(payload)),
        ).rejects.toMatchObject({
          name: 'OutboxEnvelopeError',
          code: 'OUTBOX_INVALID_ENVELOPE',
          field: expect.stringMatching(/^payload/),
        });
        expect(tx.$executeRaw).not.toHaveBeenCalled();
      },
    );

    it('rejects circular payloads before calling the database', async () => {
      const payload: Record<string, unknown> = {};
      payload.self = payload;
      const emitter = createEmitter();
      const tx = createMockTx();

      await expect(
        emitter.emit(tx, new PayloadEvent(payload)),
      ).rejects.toMatchObject({
        code: 'OUTBOX_INVALID_ENVELOPE',
        reason: 'circular',
      });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects an invalid occurredAt instead of silently storing now', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();

      await expect(
        emitter.emit(tx, new OrderPaidEvent('order-1'), {
          occurredAt: new Date('invalid'),
        }),
      ).rejects.toMatchObject({
        code: 'OUTBOX_INVALID_ENVELOPE',
        field: 'occurredAt',
        reason: 'invalid_date',
      });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects oversized payloads and metadata before calling the database', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();

      await expect(
        emitter.emit(tx, new PayloadEvent({ data: 'x'.repeat(1024 * 1024) })),
      ).rejects.toMatchObject({
        code: 'OUTBOX_INVALID_ENVELOPE',
        field: 'payload',
        reason: 'too_large',
      });
      await expect(
        emitter.emit(tx, new OrderPaidEvent('order-1'), {
          correlationId: 'x'.repeat(256),
        }),
      ).rejects.toMatchObject({
        code: 'OUTBOX_INVALID_ENVELOPE',
        field: 'correlationId',
        reason: 'too_long',
      });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('should send a PostgreSQL notification when wakeup is enabled', async () => {
      const emitter = createEmitter({
        wakeup: { enabled: true, channel: 'outbox_custom' },
      });
      const tx = createMockTx();

      await emitter.emit(tx, new OrderCreatedEvent('order-1', 50));

      expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
      const [strings, ...values] = tx.$executeRaw.mock.calls[1];
      expect(strings.join('')).toContain('pg_notify');
      expect(values).toEqual(['outbox_custom', 'order.created']);
    });
  });

  describe('emitMany', () => {
    it('should insert multiple events with a single bulk query when supported', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();

      await emitter.emitMany(tx, [
        new OrderCreatedEvent('order-1', 100),
        new OrderPaidEvent('order-1'),
      ]);

      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
      const [sql, ...values] = tx.$executeRawUnsafe.mock.calls[0];
      expect(sql).toContain('INSERT INTO outbox_events');
      expect(values).toContain('order.created');
      expect(values).toContain('order.paid');
    });

    it('should handle empty array', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();

      await emitter.emitMany(tx, []);

      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('should accept per-event metadata entries', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();

      await emitter.emitMany(tx, [
        {
          event: new OrderCreatedEvent('order-1', 100),
          options: { aggregateType: 'Order', aggregateId: 'order-1' },
        },
        {
          event: new OrderPaidEvent('order-1'),
          options: { aggregateType: 'Order', aggregateId: 'order-1' },
        },
      ]);

      expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
      const [sql, ...values] = tx.$executeRawUnsafe.mock.calls[0];
      expect(sql).toContain('INSERT INTO outbox_events');
      expect(sql).toContain('aggregate_type');
      expect(values).toContain('order.created');
      expect(values).toContain('order.paid');
      expect(values).toContain('Order');
    });

    it('should reject the whole bulk insert when any tenant provenance is invalid', async () => {
      const tenantProvider = {
        getTenantId: jest.fn().mockReturnValue('tenant-1'),
      };
      const emitter = createEmitter({
        tenancy: { provider: tenantProvider, policy: 'require-match' },
      });
      const tx = createMockTx();

      await expect(
        emitter.emitMany(tx, [
          {
            event: new OrderCreatedEvent('order-1', 100),
            options: { tenantId: 'tenant-1' },
          },
          {
            event: new OrderPaidEvent('order-1'),
            options: { tenantId: 'tenant-2' },
          },
        ]),
      ).rejects.toThrow(
        'Outbox explicit tenantId does not match the provider tenantId',
      );
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('validates every entry before the fallback path inserts any row', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();
      tx.$executeRawUnsafe = undefined as never;
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      await expect(
        emitter.emitMany(tx, [
          new OrderPaidEvent('order-1'),
          new PayloadEvent(circular),
        ]),
      ).rejects.toMatchObject({ code: 'OUTBOX_INVALID_ENVELOPE' });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('chunks bulk inserts below the PostgreSQL bind parameter limit', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();
      const events = Array.from(
        { length: 1001 },
        (_, index) => new OrderPaidEvent(`order-${index}`),
      );

      await emitter.emitMany(tx, events);

      expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(2);
      expect(tx.$executeRawUnsafe.mock.calls[0]).toHaveLength(1 + 1000 * 12);
      expect(tx.$executeRawUnsafe.mock.calls[1]).toHaveLength(1 + 12);
    });
  });
});
