import { Inject, Injectable } from '@nestjs/common';
import { OUTBOX_OPTIONS } from './outbox.constants';
import type {
  OutboxHealth,
  OutboxHealthOptions,
  OutboxListOptions,
  OutboxStats,
} from './interfaces/outbox-admin.interface';
import type { OutboxOptions } from './interfaces/outbox-options.interface';
import type { OutboxRecord } from './interfaces/outbox-record.interface';

const DEFAULT_ADMIN_LIMIT = 50;
const MAX_ADMIN_LIMIT = 500;

const RECORD_SELECT = `
  id,
  event_type,
  payload,
  status,
  created_at,
  updated_at,
  processed_at,
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

@Injectable()
export class OutboxAdminService {
  constructor(@Inject(OUTBOX_OPTIONS) private readonly options: OutboxOptions) {}

  async getStats(): Promise<OutboxStats> {
    const rows = await this.options.prisma.$queryRaw<
      Array<{
        pending: number | bigint | string | null;
        processing: number | bigint | string | null;
        sent: number | bigint | string | null;
        failed: number | bigint | string | null;
        oldest_pending_age_ms: number | bigint | string | null;
        oldest_processing_age_ms: number | bigint | string | null;
      }>
    >`
      SELECT
        COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
        COUNT(*) FILTER (WHERE status = 'PROCESSING') AS processing,
        COUNT(*) FILTER (WHERE status = 'SENT') AS sent,
        COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
        EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status = 'PENDING'))) * 1000
          AS oldest_pending_age_ms,
        EXTRACT(EPOCH FROM (NOW() - MIN(updated_at) FILTER (WHERE status = 'PROCESSING'))) * 1000
          AS oldest_processing_age_ms
      FROM outbox_events
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

  async list(options: OutboxListOptions = {}): Promise<OutboxRecord[]> {
    const values: unknown[] = [];
    const where: string[] = [];

    if (options.status) {
      values.push(options.status);
      where.push(`status = $${values.length}`);
    }

    if (options.eventType) {
      values.push(options.eventType);
      where.push(`event_type = $${values.length}`);
    }

    if (options.tenantId) {
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
        ORDER BY created_at DESC
        LIMIT $${values.length}
      `,
      ...values,
    );

    return rows.map((row) => this.mapRecord(row));
  }

  async getById(id: string): Promise<OutboxRecord | null> {
    const rows = await this.queryRawUnsafe<Record<string, unknown>[]>(
      `
        SELECT ${RECORD_SELECT}
        FROM outbox_events
        WHERE id = $1::uuid
        LIMIT 1
      `,
      id,
    );

    return rows[0] ? this.mapRecord(rows[0]) : null;
  }

  async retry(id: string): Promise<boolean> {
    const updated = await this.executeRawUnsafe(
      `
        UPDATE outbox_events
        SET status = 'PENDING',
            last_error = NULL,
            updated_at = NOW()
        WHERE id = $1::uuid
          AND status = $2
      `,
      id,
      'FAILED',
    );

    return updated > 0;
  }

  async retryMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const placeholders = ids
      .map((_, index) => `$${index + 1}::uuid`)
      .join(', ');
    const statusIndex = ids.length + 1;

    return this.executeRawUnsafe(
      `
        UPDATE outbox_events
        SET status = 'PENDING',
            last_error = NULL,
            updated_at = NOW()
        WHERE id IN (${placeholders})
          AND status = $${statusIndex}
      `,
      ...ids,
      'FAILED',
    );
  }

  async markFailed(id: string, reason: string): Promise<boolean> {
    const updated = await this.executeRawUnsafe(
      `
        UPDATE outbox_events
        SET status = 'FAILED',
            last_error = $2,
            updated_at = NOW()
        WHERE id = $1::uuid
      `,
      id,
      reason,
    );

    return updated > 0;
  }

  async purgeSent(options: { before: Date; limit?: number }): Promise<number> {
    const limit = this.normalizeLimit(options.limit);

    return this.executeRawUnsafe(
      `
        WITH candidates AS (
          SELECT id
          FROM outbox_events
          WHERE status = 'SENT'
            AND processed_at < $1
          ORDER BY processed_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM outbox_events
        WHERE id IN (SELECT id FROM candidates)
      `,
      options.before,
      limit,
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
    return {
      id: String(row.id),
      eventType: String(row.event_type ?? row.eventType),
      payload: this.toObject(row.payload),
      status: row.status as OutboxRecord['status'],
      createdAt: this.toDate(row.created_at ?? row.createdAt),
      updatedAt: this.toDate(row.updated_at ?? row.updatedAt),
      processedAt: this.toNullableDate(row.processed_at ?? row.processedAt),
      retryCount: this.toNumber(row.retry_count ?? row.retryCount),
      maxRetries: this.toNumber(row.max_retries ?? row.maxRetries),
      lastError: this.toNullableString(row.last_error ?? row.lastError),
      tenantId: this.toNullableString(row.tenant_id ?? row.tenantId),
      aggregateType: this.toNullableString(
        row.aggregate_type ?? row.aggregateType,
      ),
      aggregateId: this.toNullableString(row.aggregate_id ?? row.aggregateId),
      partitionKey: this.toNullableString(row.partition_key ?? row.partitionKey),
      idempotencyKey: this.toNullableString(
        row.idempotency_key ?? row.idempotencyKey,
      ),
      correlationId: this.toNullableString(
        row.correlation_id ?? row.correlationId,
      ),
      causationId: this.toNullableString(row.causation_id ?? row.causationId),
      headers: this.toHeaders(row.headers),
      occurredAt: this.toDate(row.occurred_at ?? row.occurredAt),
    };
  }

  private normalizeLimit(limit: number | undefined): number {
    if (limit === undefined) return DEFAULT_ADMIN_LIMIT;
    return Math.min(Math.max(Math.trunc(limit), 1), MAX_ADMIN_LIMIT);
  }

  private toObject(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
      return JSON.parse(value) as Record<string, unknown>;
    }

    if (value && typeof value === 'object') {
      return value as Record<string, unknown>;
    }

    return {};
  }

  private toHeaders(value: unknown): Record<string, string> {
    const object = this.toObject(value);
    return Object.fromEntries(
      Object.entries(object).map(([key, val]) => [key, String(val)]),
    );
  }

  private toDate(value: unknown): Date {
    return value instanceof Date ? value : new Date(String(value));
  }

  private toNullableDate(value: unknown): Date | null {
    if (value === null || value === undefined) return null;
    return this.toDate(value);
  }

  private toNullableString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    return String(value);
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
