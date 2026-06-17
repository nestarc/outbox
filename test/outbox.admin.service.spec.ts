import { OutboxAdminService } from '../src/outbox.admin.service';
import type { OutboxOptions } from '../src/interfaces/outbox-options.interface';

const now = new Date('2026-01-02T03:04:05.000Z');

function createDbRow(overrides?: Record<string, unknown>) {
  return {
    id: 'evt-1',
    event_type: 'order.created',
    payload: { orderId: 'order-1' },
    status: 'FAILED',
    created_at: now,
    updated_at: now,
    processed_at: null,
    retry_count: 2,
    max_retries: 5,
    last_error: 'handler failed',
    tenant_id: 'tenant-1',
    aggregate_type: 'Order',
    aggregate_id: 'order-1',
    partition_key: 'order-1',
    idempotency_key: 'idem-1',
    correlation_id: 'corr-1',
    causation_id: 'cause-1',
    headers: { source: 'api' },
    occurred_at: now,
    ...overrides,
  };
}

function createMockPrisma() {
  return {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    $queryRawUnsafe: jest.fn(),
    $executeRawUnsafe: jest.fn(),
  };
}

function createService(prisma = createMockPrisma()): {
  service: OutboxAdminService;
  prisma: ReturnType<typeof createMockPrisma>;
} {
  const options: OutboxOptions = { prisma };
  return { service: new OutboxAdminService(options), prisma };
}

describe('OutboxAdminService', () => {
  it('should return status counts and oldest pending/processing ages', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw.mockResolvedValue([
      {
        pending: 2n,
        processing: 1n,
        sent: 10n,
        failed: 3n,
        oldest_pending_age_ms: 5000,
        oldest_processing_age_ms: null,
      },
    ]);

    await expect(service.getStats()).resolves.toEqual({
      pending: 2,
      processing: 1,
      sent: 10,
      failed: 3,
      oldestPendingAgeMs: 5000,
      oldestProcessingAgeMs: null,
    });
  });

  it('should default stats to zeros when the aggregate query returns no rows', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(service.getStats()).resolves.toEqual({
      pending: 0,
      processing: 0,
      sent: 0,
      failed: 0,
      oldestPendingAgeMs: null,
      oldestProcessingAgeMs: null,
    });
  });

  it('should list records with parameterized filters', async () => {
    const { service, prisma } = createService();
    prisma.$queryRawUnsafe.mockResolvedValue([createDbRow()]);

    const rows = await service.list({
      status: 'FAILED',
      eventType: 'order.created',
      tenantId: 'tenant-1',
      after: new Date('2026-01-01T00:00:00.000Z'),
      before: new Date('2026-01-03T00:00:00.000Z'),
      limit: 25,
    });

    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...values] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('WHERE');
    expect(sql).toContain('status = $1');
    expect(sql).toContain('event_type = $2');
    expect(sql).toContain('tenant_id = $3');
    expect(values).toEqual([
      'FAILED',
      'order.created',
      'tenant-1',
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-03T00:00:00.000Z'),
      25,
    ]);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: 'evt-1',
        eventType: 'order.created',
        tenantId: 'tenant-1',
        aggregateType: 'Order',
        headers: { source: 'api' },
      }),
    );
  });

  it('should list records with default filters and clamp limit to the allowed range', async () => {
    const { service, prisma } = createService();
    prisma.$queryRawUnsafe.mockResolvedValue([
      createDbRow({
        payload: '{"orderId":"order-1"}',
        headers: '{"retry":2}',
        processed_at: '2026-01-02T03:04:05.000Z',
        occurred_at: '2026-01-02T03:04:05.000Z',
      }),
    ]);

    const rows = await service.list({ limit: 9999 });

    const [sql, ...values] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).not.toContain('WHERE');
    expect(values).toEqual([500]);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        payload: { orderId: 'order-1' },
        headers: { retry: '2' },
        processedAt: now,
        occurredAt: now,
      }),
    );
  });

  it('should clamp list limit to at least one', async () => {
    const { service, prisma } = createService();
    prisma.$queryRawUnsafe.mockResolvedValue([]);

    await service.list({ limit: 0 });

    const [, ...values] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(values).toEqual([1]);
  });

  it('should get a record by id', async () => {
    const { service, prisma } = createService();
    prisma.$queryRawUnsafe.mockResolvedValue([createDbRow({ id: 'evt-2' })]);

    await expect(service.getById('evt-2')).resolves.toEqual(
      expect.objectContaining({ id: 'evt-2' }),
    );

    const [sql, ...values] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('WHERE id = $1::uuid');
    expect(values).toEqual(['evt-2']);
  });

  it('should return null when getById has no match', async () => {
    const { service, prisma } = createService();
    prisma.$queryRawUnsafe.mockResolvedValue([]);

    await expect(service.getById('evt-missing')).resolves.toBeNull();
  });

  it('should reject dynamic queries when prisma lacks $queryRawUnsafe', async () => {
    const service = new OutboxAdminService({
      prisma: { $queryRaw: jest.fn(), $executeRaw: jest.fn() },
    });

    await expect(service.list()).rejects.toThrow(
      'OutboxAdminService requires prisma.$queryRawUnsafe',
    );
  });

  it('should retry only FAILED records and keep retry_count', async () => {
    const { service, prisma } = createService();
    prisma.$executeRawUnsafe.mockResolvedValue(1);

    await expect(service.retry('evt-1')).resolves.toBe(true);

    const [sql, ...values] = prisma.$executeRawUnsafe.mock.calls[0];
    expect(sql).toContain("status = 'PENDING'");
    expect(sql).toContain('last_error = NULL');
    expect(sql).toContain('WHERE id = $1::uuid');
    expect(sql).toContain('status = $2');
    expect(sql).not.toContain('retry_count = 0');
    expect(values).toEqual(['evt-1', 'FAILED']);
  });

  it('should return false when retry updates no rows', async () => {
    const { service, prisma } = createService();
    prisma.$executeRawUnsafe.mockResolvedValue(0);

    await expect(service.retry('evt-1')).resolves.toBe(false);
  });

  it('should reject dynamic updates when prisma lacks $executeRawUnsafe', async () => {
    const service = new OutboxAdminService({
      prisma: { $queryRaw: jest.fn(), $executeRaw: jest.fn() },
    });

    await expect(service.retry('evt-1')).rejects.toThrow(
      'OutboxAdminService requires prisma.$executeRawUnsafe',
    );
  });

  it('should retry many failed records', async () => {
    const { service, prisma } = createService();
    prisma.$executeRawUnsafe.mockResolvedValue(2);

    await expect(service.retryMany(['evt-1', 'evt-2'])).resolves.toBe(2);

    const [sql, ...values] = prisma.$executeRawUnsafe.mock.calls[0];
    expect(sql).toContain('id IN ($1::uuid, $2::uuid)');
    expect(sql).toContain('status = $3');
    expect(values).toEqual(['evt-1', 'evt-2', 'FAILED']);
  });

  it('should no-op retryMany for empty ids', async () => {
    const { service, prisma } = createService();

    await expect(service.retryMany([])).resolves.toBe(0);
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('should mark a record as failed with a reason', async () => {
    const { service, prisma } = createService();
    prisma.$executeRawUnsafe.mockResolvedValue(1);

    await expect(service.markFailed('evt-1', 'manual stop')).resolves.toBe(true);

    const [sql, ...values] = prisma.$executeRawUnsafe.mock.calls[0];
    expect(sql).toContain("status = 'FAILED'");
    expect(sql).toContain('last_error = $2');
    expect(values).toEqual(['evt-1', 'manual stop']);
  });

  it('should return false when markFailed updates no rows', async () => {
    const { service, prisma } = createService();
    prisma.$executeRawUnsafe.mockResolvedValue(0);

    await expect(service.markFailed('evt-1', 'manual stop')).resolves.toBe(false);
  });

  it('should purge only SENT rows older than the cutoff', async () => {
    const { service, prisma } = createService();
    const before = new Date('2026-01-01T00:00:00.000Z');
    prisma.$executeRawUnsafe.mockResolvedValue(10);

    await expect(service.purgeSent({ before, limit: 10 })).resolves.toBe(10);

    const [sql, ...values] = prisma.$executeRawUnsafe.mock.calls[0];
    expect(sql).toContain("status = 'SENT'");
    expect(sql).toContain('processed_at < $1');
    expect(sql).toContain('LIMIT $2');
    expect(values).toEqual([before, 10]);
  });

  it('should evaluate health thresholds from stats', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw.mockResolvedValue([
      {
        pending: 4,
        processing: 0,
        sent: 10,
        failed: 3,
        oldest_pending_age_ms: 60000,
        oldest_processing_age_ms: null,
      },
    ]);

    await expect(
      service.getHealth({
        maxOldestPendingAgeMs: 30000,
        maxFailedCount: 1,
      }),
    ).resolves.toEqual({
      ok: false,
      stats: expect.objectContaining({ pending: 4, failed: 3 }),
      reasons: [
        'oldest pending event age 60000ms exceeds threshold 30000ms',
        'failed event count 3 exceeds threshold 1',
      ],
    });
  });

  it('should report healthy when thresholds are not exceeded', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw.mockResolvedValue([
      {
        pending: '0',
        processing: '0',
        sent: '10',
        failed: '0',
        oldest_pending_age_ms: null,
        oldest_processing_age_ms: null,
      },
    ]);

    await expect(
      service.getHealth({
        maxOldestPendingAgeMs: 30000,
        maxFailedCount: 1,
      }),
    ).resolves.toEqual({
      ok: true,
      stats: expect.objectContaining({ sent: 10, failed: 0 }),
      reasons: [],
    });
  });
});
