import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { OUTBOX_OPTIONS } from './outbox.constants';
import { OutboxSchemaError } from './errors/outbox-schema.error';
import type { OutboxOptions } from './interfaces/outbox-options.interface';

export const REQUIRED_OUTBOX_SCHEMA_VERSION = '0.3.0';

const REQUIRED_COLUMNS = [
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
] as const;

const REQUIRED_INDEXES = [
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
] as const;

const REQUIRED_CONSTRAINTS = [
  'chk_status',
  'chk_retry_count_nonnegative',
  'chk_max_retries_positive',
  'chk_payload_object',
  'chk_headers_object',
  'chk_nonprocessing_claim_clear',
] as const;

type SchemaInventoryRow = {
  tableExists: boolean;
  columns: string[];
  indexes: string[];
  constraints: string[];
};

/**
 * Fails during Nest initialization with an actionable version diagnosis before
 * poller/admin SQL can fail with a generic missing-column error.
 */
@Injectable()
export class OutboxSchemaGuard implements OnModuleInit {
  private validation: Promise<void> | null = null;

  constructor(
    @Inject(OUTBOX_OPTIONS) private readonly options: OutboxOptions,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.assertCompatible();
  }

  assertCompatible(): Promise<void> {
    this.validation ??= this.inspect();
    return this.validation;
  }

  private async inspect(): Promise<void> {
    const rows = await this.options.prisma.$queryRaw<SchemaInventoryRow[]>`
      SELECT
        to_regclass('outbox_events') IS NOT NULL AS "tableExists",
        COALESCE(
          ARRAY(
            SELECT column_name::text
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'outbox_events'
          ),
          ARRAY[]::text[]
        ) AS columns,
        COALESCE(
          ARRAY(
            SELECT indexname::text
            FROM pg_indexes
            WHERE schemaname = current_schema()
              AND tablename = 'outbox_events'
          ),
          ARRAY[]::text[]
        ) AS indexes,
        COALESCE(
          ARRAY(
            SELECT conname::text
            FROM pg_constraint
            WHERE conrelid = to_regclass('outbox_events')
          ),
          ARRAY[]::text[]
        ) AS constraints
    `;
    const inventory = rows[0];
    if (!inventory) {
      throw new OutboxSchemaError(REQUIRED_OUTBOX_SCHEMA_VERSION, 'unknown', [
        'schema inventory',
      ]);
    }

    const missing = [
      ...REQUIRED_COLUMNS.filter(
        (name) => !inventory.columns.includes(name),
      ).map((name) => `column:${name}`),
      ...REQUIRED_INDEXES.filter(
        (name) => !inventory.indexes.includes(name),
      ).map((name) => `index:${name}`),
      ...REQUIRED_CONSTRAINTS.filter(
        (name) => !inventory.constraints.includes(name),
      ).map((name) => `constraint:${name}`),
    ];
    if (!inventory.tableExists || missing.length > 0) {
      throw new OutboxSchemaError(
        REQUIRED_OUTBOX_SCHEMA_VERSION,
        this.classifyActualVersion(inventory),
        inventory.tableExists ? missing : ['table:outbox_events'],
      );
    }
  }

  private classifyActualVersion(inventory: SchemaInventoryRow): string {
    if (!inventory.tableExists) return 'missing';
    if (!inventory.columns.includes('aggregate_type')) return '0.1.x';
    if (!inventory.columns.includes('claim_token')) return '0.2.x';
    return 'incomplete-current';
  }
}
