import {
  OutboxSchemaGuard,
  REQUIRED_OUTBOX_SCHEMA_VERSION,
} from '../src/outbox.schema';

const currentInventory = {
  tableExists: true,
  columns: [
    'id',
    'event_type',
    'payload',
    'status',
    'created_at',
    'updated_at',
    'processed_at',
    'next_attempt_at',
    'retry_count',
    'max_retries',
    'last_error',
    'tenant_id',
    'aggregate_type',
    'aggregate_id',
    'partition_key',
    'idempotency_key',
    'correlation_id',
    'causation_id',
    'headers',
    'occurred_at',
    'claim_token',
    'lease_expires_at',
  ],
  indexes: [
    'idx_outbox_pending',
    'idx_outbox_processing',
    'idx_outbox_processing_claim_token',
    'idx_outbox_processing_lease_expiry',
    'idx_outbox_failed',
    'idx_outbox_admin_created',
    'idx_outbox_tenant_admin',
    'idx_outbox_tenant_status_admin',
    'idx_outbox_tenant_processing',
    'idx_outbox_sent_retention',
    'idx_outbox_tenant_sent_retention',
  ],
  constraints: [
    'chk_status',
    'chk_retry_count_nonnegative',
    'chk_max_retries_positive',
    'chk_payload_object',
    'chk_headers_object',
    'chk_nonprocessing_claim_clear',
  ],
};

function createGuard(inventory: typeof currentInventory) {
  const prisma = { $queryRaw: jest.fn().mockResolvedValue([inventory]) };
  return { guard: new OutboxSchemaGuard({ prisma }), prisma };
}

describe('OutboxSchemaGuard', () => {
  it('accepts the complete current structural inventory', async () => {
    const { guard, prisma } = createGuard(currentInventory);
    await expect(
      Promise.all([
        guard.assertCompatible(),
        guard.assertCompatible(),
        guard.onModuleInit(),
      ]),
    ).resolves.toEqual([undefined, undefined, undefined]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('diagnoses a v0.2 schema before generic runtime SQL fails', async () => {
    const { guard } = createGuard({
      ...currentInventory,
      columns: currentInventory.columns.filter(
        (name) =>
          !['claim_token', 'lease_expires_at', 'next_attempt_at'].includes(
            name,
          ),
      ),
    });

    await expect(guard.onModuleInit()).rejects.toMatchObject({
      name: 'OutboxSchemaError',
      code: 'OUTBOX_SCHEMA_MISMATCH',
      requiredVersion: REQUIRED_OUTBOX_SCHEMA_VERSION,
      actualVersion: '0.2.x',
      missing: expect.arrayContaining([
        'column:claim_token',
        'column:next_attempt_at',
      ]),
    });
  });

  it('diagnoses a missing table with an actionable upgrade path', async () => {
    const { guard } = createGuard({
      tableExists: false,
      columns: [],
      indexes: [],
      constraints: [],
    });

    await expect(guard.onModuleInit()).rejects.toMatchObject({
      actualVersion: 'missing',
      missing: ['table:outbox_events'],
    });
  });
});
