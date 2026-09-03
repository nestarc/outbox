import { Inject, Injectable } from '@nestjs/common';
import { OUTBOX_OPTIONS } from './outbox.constants';
import type {
  OutboxHealth,
  OutboxHealthOptions,
  OutboxListPage,
  OutboxListOptions,
  OutboxAdminMutationResult,
  OutboxStats,
  OutboxTenantListOptions,
} from './interfaces/outbox-admin.interface';
import type { OutboxOptions } from './interfaces/outbox-options.interface';
import { parsePersistedOutboxRecord } from './outbox-invariants';
import type { OutboxRecord } from './interfaces/outbox-record.interface';
import { OutboxCursorError } from './errors/outbox-cursor.error';

const DEFAULT_ADMIN_LIMIT = 50;
const MAX_ADMIN_LIMIT = 500;
// Leaves ample room below PostgreSQL's bind-parameter limit for the status and
// optional tenant predicate while keeping each statement reasonably sized.
const RETRY_MANY_CHUNK_SIZE = 10_000;

const RECORD_SELECT = `
  id,
  event_type,
  payload,
  status,
  created_at,
  updated_at,
  processed_at,
  next_attempt_at,
  retry_count,
  max_retries,
  last_error,
  tenant_id,
  aggregate_type,
  aggregate_id,
  partition_key,
  idempotency_key,
  correlation_id,
  causation_id,
  headers,
  occurred_at
`;

type OutboxStatsRow = {
  pending: number | bigint | string | null;
  processing: number | bigint | string | null;
  sent: number | bigint | string | null;
  failed: number | bigint | string | null;
  oldest_pending_age_ms: number | bigint | string | null;
  oldest_processing_age_ms: number | bigint | string | null;
};

type AdminCursorV1 = {
  v: 1;
  createdAt: string;
  id: string;
  order: 'created_at_desc_id_desc';
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

abstract class OutboxAdminBase<TListOptions extends OutboxListOptions> {
  protected constructor(
    protected readonly options: OutboxOptions,
    private readonly expectedTenantId: string | null,
  ) {}

  async getStats(): Promise<OutboxStats> {
    const rows = this.expectedTenantId
      ? await this.queryRawUnsafe<OutboxStatsRow[]>(
          `
            SELECT
              pending.count AS pending,
              processing.count AS processing,
              sent.count AS sent,
              failed.count AS failed,
              EXTRACT(EPOCH FROM (NOW() - pending.oldest_at)) * 1000 AS oldest_pending_age_ms,
              EXTRACT(EPOCH FROM (NOW() - processing.oldest_at)) * 1000 AS oldest_processing_age_ms
            FROM
              (SELECT COUNT(*) AS count, MIN(created_at) AS oldest_at
               FROM outbox_events WHERE tenant_id = $1 AND status = 'PENDING') pending,
              (SELECT COUNT(*) AS count, MIN(updated_at) AS oldest_at
               FROM outbox_events WHERE tenant_id = $1 AND status = 'PROCESSING') processing,
              (SELECT COUNT(*) AS count
               FROM outbox_events WHERE tenant_id = $1 AND status = 'SENT') sent,
              (SELECT COUNT(*) AS count
               FROM outbox_events WHERE tenant_id = $1 AND status = 'FAILED') failed
          `,
          this.expectedTenantId,
        )
      : await this.options.prisma.$queryRaw<OutboxStatsRow[]>`
          SELECT
            pending.count AS pending,
            processing.count AS processing,
            sent.count AS sent,
            failed.count AS failed,
            EXTRACT(EPOCH FROM (NOW() - pending.oldest_at)) * 1000 AS oldest_pending_age_ms,
            EXTRACT(EPOCH FROM (NOW() - processing.oldest_at)) * 1000 AS oldest_processing_age_ms
          FROM
            (SELECT COUNT(*) AS count, MIN(created_at) AS oldest_at
             FROM outbox_events WHERE status = 'PENDING') pending,
            (SELECT COUNT(*) AS count, MIN(updated_at) AS oldest_at
             FROM outbox_events WHERE status = 'PROCESSING') processing,
            (SELECT COUNT(*) AS count
             FROM outbox_events WHERE status = 'SENT') sent,
            (SELECT COUNT(*) AS count
             FROM outbox_events WHERE status = 'FAILED') failed
        `;
    const row = rows[0] ?? {};

    return {
      pending: this.toNumber(row.pending),
      processing: this.toNumber(row.processing),
      sent: this.toNumber(row.sent),
      failed: this.toNumber(row.failed),
      oldestPendingAgeMs: this.toNullableNumber(row.oldest_pending_age_ms),
      oldestProcessingAgeMs: this.toNullableNumber(
        row.oldest_processing_age_ms,
      ),
    };
  }

  async list(
    options: TListOptions = {} as TListOptions,
  ): Promise<OutboxRecord[]> {
    const values: unknown[] = [];
    const where: string[] = [];

    if (this.expectedTenantId) {
      values.push(this.expectedTenantId);
      where.push(`tenant_id = $${values.length}`);
    }

    if (options.status) {
      values.push(options.status);
      where.push(`status = $${values.length}`);
    }

    if (options.eventType) {
      values.push(options.eventType);
      where.push(`event_type = $${values.length}`);
    }

    if (!this.expectedTenantId && options.tenantId) {
      values.push(options.tenantId);
      where.push(`tenant_id = $${values.length}`);
    }

    if (options.after) {
      values.push(options.after);
      where.push(`created_at >= $${values.length}`);
    }

    if (options.before) {
      values.push(options.before);
      where.push(`created_at < $${values.length}`);
    }

    const limit = this.normalizeLimit(options.limit);
    values.push(limit);

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await this.queryRawUnsafe<Record<string, unknown>[]>(
      `
        SELECT ${RECORD_SELECT}
        FROM outbox_events
        ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${values.length}
      `,
      ...values,
    );

    return rows.map((row) => this.mapRecord(row));
  }

  /**
   * Deterministic descending pagination. The cursor is an opaque, versioned,
   * exclusive boundary over `(created_at, id)`.
   */
  async listPage(
    options: TListOptions & { cursor?: string } = {} as TListOptions,
  ): Promise<OutboxListPage> {
    const values: unknown[] = [];
    const where: string[] = [];

    if (this.expectedTenantId) {
      values.push(this.expectedTenantId);
      where.push(`tenant_id = $${values.length}`);
    }

    if (options.status) {
      values.push(options.status);
      where.push(`status = $${values.length}`);
    }

    if (options.eventType) {
      values.push(options.eventType);
      where.push(`event_type = $${values.length}`);
    }

    if (!this.expectedTenantId && options.tenantId) {
      values.push(options.tenantId);
      where.push(`tenant_id = $${values.length}`);
    }

    if (options.after) {
      values.push(options.after);
      where.push(`created_at >= $${values.length}`);
    }

    if (options.before) {
      values.push(options.before);
      where.push(`created_at < $${values.length}`);
    }

    if (options.cursor !== undefined) {
      const cursor = this.decodeCursor(options.cursor);
      values.push(cursor.createdAt);
      const createdAtIndex = values.length;
      values.push(cursor.id);
      const idIndex = values.length;
      where.push(`(created_at, id) < ($${createdAtIndex}, $${idIndex}::uuid)`);
    }

    const limit = this.normalizeLimit(options.limit);
    values.push(limit + 1);

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await this.queryRawUnsafe<Record<string, unknown>[]>(
      `
        SELECT ${RECORD_SELECT}
        FROM outbox_events
        ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${values.length}
      `,
      ...values,
    );

    const hasNextPage = rows.length > limit;
    const records = rows.slice(0, limit).map((row) => this.mapRecord(row));
    const boundary = records.at(-1);

    return {
      records,
      nextCursor: hasNextPage && boundary ? this.encodeCursor(boundary) : null,
    };
  }

  async getById(id: string): Promise<OutboxRecord | null> {
    const values: unknown[] = [id];
    let tenantSql = '';
    if (this.expectedTenantId) {
      values.push(this.expectedTenantId);
      tenantSql = `AND tenant_id = $${values.length}`;
    }
    const rows = await this.queryRawUnsafe<Record<string, unknown>[]>(
      `
        SELECT ${RECORD_SELECT}
        FROM outbox_events
        WHERE id = $1::uuid
          ${tenantSql}
        LIMIT 1
      `,
      ...values,
    );

    return rows[0] ? this.mapRecord(rows[0]) : null;
  }

  async retry(id: string): Promise<OutboxAdminMutationResult> {
    const values: unknown[] = [id, 'FAILED'];
    let targetTenantSql = '';
    let currentTenantSql = '';
    if (this.expectedTenantId) {
      values.push(this.expectedTenantId);
      targetTenantSql = `AND tenant_id = $${values.length}`;
      currentTenantSql = `AND current.tenant_id = $${values.length}`;
    }
    const rows = await this.queryRawUnsafe<
      Array<{ outcome: string; current_status: unknown }>
    >(
      `
        WITH target AS MATERIALIZED (
          SELECT id, status
          FROM outbox_events
          WHERE id = $1::uuid
            ${targetTenantSql}
        ),
        updated AS (
          UPDATE outbox_events AS current
          SET status = 'PENDING',
              claim_token = NULL,
              lease_expires_at = NULL,
              last_error = NULL,
              processed_at = NULL,
              next_attempt_at = NOW(),
              updated_at = NOW()
          WHERE current.id = $1::uuid
            AND current.status = $2
            ${currentTenantSql}
            AND EXISTS (
              SELECT 1
              FROM target
              WHERE target.id = current.id
                AND target.status = $2
            )
          RETURNING current.id
        )
        SELECT
          CASE
            WHEN EXISTS (SELECT 1 FROM updated) THEN 'applied'
            WHEN NOT EXISTS (SELECT 1 FROM target) THEN 'not_found'
            WHEN (SELECT status FROM target) <> $2 THEN 'conflict'
            ELSE 'lost_claim'
          END AS outcome,
          (SELECT status FROM target) AS current_status
      `,
      ...values,
    );

    return this.mapMutationResult(rows[0]);
  }

  async retryMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    // Duplicates are removed before chunking. Each chunk is independently
    // committed by the supplied Prisma client; if a later chunk fails, callers
    // may safely retry the complete request because only FAILED rows qualify.
    const uniqueIds = [...new Set(ids)];
    let updated = 0;
    for (
      let offset = 0;
      offset < uniqueIds.length;
      offset += RETRY_MANY_CHUNK_SIZE
    ) {
      const chunk = uniqueIds.slice(offset, offset + RETRY_MANY_CHUNK_SIZE);
      const placeholders = chunk
        .map((_, index) => `$${index + 1}::uuid`)
        .join(', ');
      const statusIndex = chunk.length + 1;
      const tenantIndex = statusIndex + 1;
      const tenantSql = this.expectedTenantId
        ? `AND tenant_id = $${tenantIndex}`
        : '';
      const values: unknown[] = [...chunk, 'FAILED'];
      if (this.expectedTenantId) values.push(this.expectedTenantId);

      updated += await this.executeRawUnsafe(
        `
          UPDATE outbox_events
          SET status = 'PENDING',
              claim_token = NULL,
              lease_expires_at = NULL,
              last_error = NULL,
              processed_at = NULL,
              next_attempt_at = NOW(),
              updated_at = NOW()
          WHERE id IN (${placeholders})
            AND status = $${statusIndex}
            ${tenantSql}
        `,
        ...values,
      );
    }

    return updated;
  }

  async markFailed(
    id: string,
    reason: string,
  ): Promise<OutboxAdminMutationResult> {
    const values: unknown[] = [id, reason];
    let targetTenantSql = '';
    let currentTenantSql = '';
    if (this.expectedTenantId) {
      values.push(this.expectedTenantId);
      targetTenantSql = `AND tenant_id = $${values.length}`;
      currentTenantSql = `AND current.tenant_id = $${values.length}`;
    }
    const rows = await this.queryRawUnsafe<
      Array<{ outcome: string; current_status: unknown }>
    >(
      `
        WITH target AS MATERIALIZED (
          SELECT id, status
          FROM outbox_events
          WHERE id = $1::uuid
            ${targetTenantSql}
        ),
        updated AS (
          UPDATE outbox_events AS current
          SET status = 'FAILED',
              claim_token = NULL,
              lease_expires_at = NULL,
              last_error = $2,
              processed_at = NOW(),
              next_attempt_at = NULL,
              updated_at = NOW()
          WHERE current.id = $1::uuid
            AND current.status = 'PENDING'
            ${currentTenantSql}
            AND EXISTS (
              SELECT 1
              FROM target
              WHERE target.id = current.id
                AND target.status = 'PENDING'
            )
          RETURNING current.id
        )
        SELECT
          CASE
            WHEN EXISTS (SELECT 1 FROM updated) THEN 'applied'
            WHEN NOT EXISTS (SELECT 1 FROM target) THEN 'not_found'
            WHEN (SELECT status FROM target) <> 'PENDING' THEN 'conflict'
            ELSE 'lost_claim'
          END AS outcome,
          (SELECT status FROM target) AS current_status
      `,
      ...values,
    );

    return this.mapMutationResult(rows[0]);
  }

  async purgeSent(options: { before: Date; limit?: number }): Promise<number> {
    const limit = this.normalizeLimit(options.limit);
    const values: unknown[] = [options.before, limit];
    let candidateTenantSql = '';
    let deleteTenantSql = '';
    if (this.expectedTenantId) {
      values.push(this.expectedTenantId);
      candidateTenantSql = `AND tenant_id = $${values.length}`;
      deleteTenantSql = `AND tenant_id = $${values.length}`;
    }

    return this.executeRawUnsafe(
      `
        WITH candidates AS (
          SELECT id
          FROM outbox_events
          WHERE status = 'SENT'
            AND processed_at < $1
            ${candidateTenantSql}
          ORDER BY processed_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM outbox_events
        WHERE id IN (SELECT id FROM candidates)
          ${deleteTenantSql}
      `,
      ...values,
    );
  }

  async getHealth(options: OutboxHealthOptions = {}): Promise<OutboxHealth> {
    const stats = await this.getStats();
    const reasons: string[] = [];

    if (
      options.maxOldestPendingAgeMs !== undefined &&
      stats.oldestPendingAgeMs !== null &&
      stats.oldestPendingAgeMs > options.maxOldestPendingAgeMs
    ) {
      reasons.push(
        `oldest pending event age ${stats.oldestPendingAgeMs}ms exceeds threshold ${options.maxOldestPendingAgeMs}ms`,
      );
    }

    if (
      options.maxFailedCount !== undefined &&
      stats.failed > options.maxFailedCount
    ) {
      reasons.push(
        `failed event count ${stats.failed} exceeds threshold ${options.maxFailedCount}`,
      );
    }

    return {
      ok: reasons.length === 0,
      stats,
      reasons,
    };
  }

  private async queryRawUnsafe<T>(
    sql: string,
    ...values: unknown[]
  ): Promise<T> {
    const queryRawUnsafe = this.options.prisma.$queryRawUnsafe;
    if (!queryRawUnsafe) {
      throw new Error(
        'OutboxAdminService requires prisma.$queryRawUnsafe for parameterized dynamic queries',
      );
    }

    return queryRawUnsafe.call(this.options.prisma, sql, ...values);
  }

  private async executeRawUnsafe(
    sql: string,
    ...values: unknown[]
  ): Promise<number> {
    const executeRawUnsafe = this.options.prisma.$executeRawUnsafe;
    if (!executeRawUnsafe) {
      throw new Error(
        'OutboxAdminService requires prisma.$executeRawUnsafe for parameterized dynamic updates',
      );
    }

    return executeRawUnsafe.call(this.options.prisma, sql, ...values);
  }

  private mapRecord(row: Record<string, unknown>): OutboxRecord {
    return parsePersistedOutboxRecord(row);
  }

  private encodeCursor(record: OutboxRecord): string {
    const cursor: AdminCursorV1 = {
      v: 1,
      createdAt: record.createdAt.toISOString(),
      id: record.id,
      order: 'created_at_desc_id_desc',
    };
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string): { createdAt: Date; id: string } {
    try {
      if (cursor.length === 0 || /\s/.test(cursor)) {
        throw new Error('empty cursor');
      }
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor) {
        throw new Error('non-canonical cursor');
      }
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        (parsed as Partial<AdminCursorV1>).v !== 1 ||
        (parsed as Partial<AdminCursorV1>).order !==
          'created_at_desc_id_desc' ||
        typeof (parsed as Partial<AdminCursorV1>).createdAt !== 'string' ||
        typeof (parsed as Partial<AdminCursorV1>).id !== 'string' ||
        !UUID_PATTERN.test((parsed as AdminCursorV1).id)
      ) {
        throw new Error('invalid cursor shape');
      }
      const createdAt = new Date((parsed as AdminCursorV1).createdAt);
      if (
        !Number.isFinite(createdAt.getTime()) ||
        createdAt.toISOString() !== (parsed as AdminCursorV1).createdAt
      ) {
        throw new Error('invalid cursor date');
      }
      return { createdAt, id: (parsed as AdminCursorV1).id };
    } catch (error) {
      if (error instanceof OutboxCursorError) throw error;
      throw new OutboxCursorError();
    }
  }

  private mapMutationResult(row: {
    outcome: string;
    current_status: unknown;
  }): OutboxAdminMutationResult {
    switch (row.outcome) {
      case 'applied':
      case 'not_found':
      case 'lost_claim':
        return { outcome: row.outcome };
      case 'conflict':
        return {
          outcome: 'conflict',
          currentStatus: String(row.current_status) as OutboxRecord['status'],
        };
      default:
        throw new Error(
          `Unknown outbox admin mutation outcome: ${row.outcome}`,
        );
    }
  }

  private normalizeLimit(limit: number | undefined): number {
    if (limit === undefined) return DEFAULT_ADMIN_LIMIT;
    return Math.min(Math.max(Math.trunc(limit), 1), MAX_ADMIN_LIMIT);
  }

  private toNullableNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    return this.toNumber(value);
  }

  private toNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    return Number(value);
  }
}

/**
 * Privileged global outbox control-plane access. The package does not perform
 * caller authentication or RBAC for this service.
 */
@Injectable()
export class OutboxOperatorService extends OutboxAdminBase<OutboxListOptions> {
  constructor(@Inject(OUTBOX_OPTIONS) options: OutboxOptions) {
    super(options, null);
  }
}

/**
 * @deprecated Use {@link OutboxOperatorService}. This compatibility name is a
 * privileged global control-plane API and is not tenant-safe by itself.
 */
export { OutboxOperatorService as OutboxAdminService };

class OutboxTenantAdminScope extends OutboxAdminBase<OutboxTenantListOptions> {
  constructor(options: OutboxOptions, expectedTenantId: string) {
    super(options, expectedTenantId);
  }
}

/**
 * Creates an outbox admin API whose every query is fenced by one expected
 * tenant id. The caller remains responsible for authorizing that identity.
 */
@Injectable()
export class OutboxTenantAdminService {
  constructor(
    @Inject(OUTBOX_OPTIONS) private readonly options: OutboxOptions,
  ) {}

  forTenant(expectedTenantId: string): OutboxTenantAdminScope {
    if (
      typeof expectedTenantId !== 'string' ||
      expectedTenantId.length === 0 ||
      expectedTenantId.trim() !== expectedTenantId
    ) {
      throw new Error(
        'Outbox tenant admin scope requires a non-empty canonical tenant id',
      );
    }

    return new OutboxTenantAdminScope(this.options, expectedTenantId);
  }
}
