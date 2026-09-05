import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  DEFAULT_MAX_RETRIES,
  OUTBOX_OPTIONS,
  OUTBOX_TENANT_PROVIDER,
} from './outbox.constants';
import type {
  OutboxEmitManyEntry,
  OutboxEmitOptions,
} from './interfaces/outbox-emit-options.interface';
import type { OutboxEmitContext } from './interfaces/outbox-hooks.interface';
import type { OutboxOptions } from './interfaces/outbox-options.interface';
import type { PrismaTransactionClient } from './interfaces/prisma-transaction-client.interface';
import type {
  OutboxTenantPolicy,
  OutboxTenantProvider,
} from './interfaces/outbox-tenancy.interface';
import type { OutboxEvent } from './outbox.event';
import {
  OutboxEnvelopeError,
  type OutboxEnvelopeErrorReason,
} from './errors/outbox-envelope.error';

interface PreparedOutboxRow {
  eventType: string;
  payload: Record<string, unknown>;
  payloadJson: string;
  maxRetries: number;
  tenantId: string | null;
  aggregateType: string | null;
  aggregateId: string | null;
  partitionKey: string | null;
  idempotencyKey: string | null;
  correlationId: string | null;
  causationId: string | null;
  headers: Record<string, string>;
  headersJson: string;
  occurredAt: Date | null;
}

const DEFAULT_WAKEUP_CHANNEL = 'outbox_events';
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_HEADERS_BYTES = 64 * 1024;
const MAX_HEADER_VALUE_LENGTH = 8192;
const MAX_JSON_DEPTH = 100;
// 12 bind values per row. 1,000 stays well below PostgreSQL's 65,535 bind
// limit and JavaScript engines' practical variadic-call argument limit.
const EMIT_MANY_CHUNK_SIZE = 1000;

@Injectable()
export class OutboxEmitter {
  private readonly logger = new Logger(OutboxEmitter.name);
  private readonly maxRetries: number;

  constructor(
    @Inject(OUTBOX_OPTIONS) private readonly options: OutboxOptions,
    @Optional()
    @Inject(OUTBOX_TENANT_PROVIDER)
    private readonly tenantProvider?: OutboxTenantProvider | null,
  ) {
    this.maxRetries = options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async emit(
    tx: PrismaTransactionClient,
    event: OutboxEvent,
    options?: OutboxEmitOptions,
  ): Promise<void> {
    const row = await this.prepareRow(event, options);

    await this.insertPreparedRow(tx, row);

    await this.notify(tx, row.eventType);
    await this.runOnEmitHook(row);
  }

  async emitMany(
    tx: PrismaTransactionClient,
    events: OutboxEmitManyEntry[],
  ): Promise<void> {
    if (events.length === 0) return;

    // Validate the complete envelope before staging any row. This keeps the
    // fallback path all-or-nothing even when a caller catches validation errors.
    const rows = await Promise.all(
      events.map((entry) => {
        const normalized = this.normalizeEntry(entry);
        return this.prepareRow(normalized.event, normalized.options);
      }),
    );

    if (tx.$executeRawUnsafe) {
      for (
        let offset = 0;
        offset < rows.length;
        offset += EMIT_MANY_CHUNK_SIZE
      ) {
        await this.insertPreparedRows(
          tx,
          rows.slice(offset, offset + EMIT_MANY_CHUNK_SIZE),
        );
      }
    } else {
      for (const row of rows) {
        await this.insertPreparedRow(tx, row);
      }
    }

    await this.notify(tx, rows[0]?.eventType ?? 'outbox.events');

    for (const row of rows) {
      await this.runOnEmitHook(row);
    }
  }

  private async insertPreparedRow(
    tx: PrismaTransactionClient,
    row: PreparedOutboxRow,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO outbox_events (
        event_type,
        payload,
        max_retries,
        tenant_id,
        aggregate_type,
        aggregate_id,
        partition_key,
        idempotency_key,
        correlation_id,
        causation_id,
        headers,
        occurred_at
      )
      VALUES (
        ${row.eventType},
        ${row.payloadJson}::jsonb,
        ${row.maxRetries},
        ${row.tenantId},
        ${row.aggregateType},
        ${row.aggregateId},
        ${row.partitionKey},
        ${row.idempotencyKey},
        ${row.correlationId},
        ${row.causationId},
        ${row.headersJson}::jsonb,
        COALESCE(${row.occurredAt}, NOW())
      )
    `;
  }

  private async insertPreparedRows(
    tx: PrismaTransactionClient,
    rows: PreparedOutboxRow[],
  ): Promise<void> {
    const values: unknown[] = [];
    const valueGroups = rows.map((row) => {
      const offset = values.length;
      values.push(
        row.eventType,
        row.payloadJson,
        row.maxRetries,
        row.tenantId,
        row.aggregateType,
        row.aggregateId,
        row.partitionKey,
        row.idempotencyKey,
        row.correlationId,
        row.causationId,
        row.headersJson,
        row.occurredAt,
      );

      return `($${offset + 1}, $${offset + 2}::jsonb, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}::jsonb, COALESCE($${offset + 12}::timestamptz, NOW()))`;
    });

    await tx.$executeRawUnsafe!(
      `
        INSERT INTO outbox_events (
          event_type,
          payload,
          max_retries,
          tenant_id,
          aggregate_type,
          aggregate_id,
          partition_key,
          idempotency_key,
          correlation_id,
          causation_id,
          headers,
          occurred_at
        )
        VALUES ${valueGroups.join(', ')}
      `,
      ...values,
    );
  }

  private normalizeEntry(entry: OutboxEmitManyEntry): {
    event: OutboxEvent;
    options?: OutboxEmitOptions;
  } {
    if ('event' in entry) {
      return entry;
    }

    return { event: entry };
  }

  private async prepareRow(
    event: OutboxEvent,
    options?: OutboxEmitOptions,
  ): Promise<PreparedOutboxRow> {
    const eventType = this.validateIdentifier(
      event.getEventType(),
      'eventType',
    );
    const { value: payload, json: payloadJson } = this.normalizeJsonObject(
      event.toPayload(),
      'payload',
      MAX_PAYLOAD_BYTES,
    );
    const { value: headers, json: headersJson } = this.normalizeHeaders(
      options?.headers,
    );

    return {
      eventType,
      payload,
      payloadJson,
      maxRetries: this.maxRetries,
      tenantId: await this.resolveTenantId(options),
      aggregateType: this.validateOptionalIdentifier(
        options?.aggregateType,
        'aggregateType',
      ),
      aggregateId: this.validateOptionalIdentifier(
        options?.aggregateId,
        'aggregateId',
      ),
      partitionKey: this.validateOptionalIdentifier(
        options?.partitionKey,
        'partitionKey',
      ),
      idempotencyKey: this.validateOptionalIdentifier(
        options?.idempotencyKey,
        'idempotencyKey',
      ),
      correlationId: this.validateOptionalIdentifier(
        options?.correlationId,
        'correlationId',
      ),
      causationId: this.validateOptionalIdentifier(
        options?.causationId,
        'causationId',
      ),
      headers,
      headersJson,
      occurredAt: this.validateOccurredAt(options?.occurredAt),
    };
  }

  private async resolveTenantId(
    options?: OutboxEmitOptions,
  ): Promise<string | null> {
    const tenantId = (options as { tenantId?: unknown } | undefined)?.tenantId;
    const tenantScope = (options as { tenantScope?: unknown } | undefined)
      ?.tenantScope;
    const policy = this.resolveTenantPolicy();

    if (tenantScope !== undefined) {
      if (tenantScope !== 'global') {
        this.invalid(
          'tenantScope',
          'invalid_type',
          'Outbox tenantScope must be "global" when provided',
        );
      }
      if (tenantId !== undefined) {
        this.invalid(
          'tenantId',
          'invalid_type',
          'Outbox emit options cannot combine tenantId with tenantScope',
        );
      }
      return null;
    }

    if (tenantId === null) {
      this.invalid(
        'tenantId',
        'invalid_type',
        'Outbox tenantId cannot be null; use tenantScope: "global" for a global event',
      );
    }

    if (tenantId !== undefined) {
      const explicitTenantId = this.validateTenantId(
        tenantId,
        'explicit tenantId',
      );

      if (policy !== 'require-match') {
        return explicitTenantId;
      }

      const providerTenantId = await this.getProviderTenantId();
      if (providerTenantId === null) {
        this.invalid(
          'tenantId',
          'invalid_type',
          'Outbox tenancy policy "require-match" requires a provider tenantId',
        );
      }
      if (providerTenantId !== explicitTenantId) {
        this.invalid(
          'tenantId',
          'invalid_type',
          'Outbox explicit tenantId does not match the provider tenantId',
        );
      }
      return explicitTenantId;
    }

    const providerTenantId = await this.getProviderTenantId();
    if (providerTenantId !== null) return providerTenantId;

    if (policy === 'optional') return null;

    return this.invalid(
      'tenantId',
      'invalid_type',
      `Outbox tenancy policy "${policy}" requires a tenantId or tenantScope: "global"`,
    );
  }

  private resolveTenantPolicy(): OutboxTenantPolicy {
    const policy = this.options.tenancy?.policy ?? 'optional';
    if (
      policy !== 'optional' &&
      policy !== 'required' &&
      policy !== 'require-match'
    ) {
      return this.invalid(
        'tenancy.policy',
        'invalid_type',
        'Outbox tenancy.policy must be one of: optional, required, require-match',
      );
    }
    return policy;
  }

  private async getProviderTenantId(): Promise<string | null> {
    const provider = this.resolveTenantProvider();
    if (!provider?.getTenantId) return null;

    const tenantId: unknown = await provider.getTenantId();
    if (tenantId === null || tenantId === undefined) return null;
    return this.validateTenantId(tenantId, 'provider tenantId');
  }

  private validateTenantId(value: unknown, source: string): string {
    if (typeof value !== 'string') {
      return this.invalid(
        'tenantId',
        'invalid_type',
        `Outbox ${source} must be a string`,
      );
    }
    if (value.length === 0 || value.trim() !== value) {
      return this.invalid(
        'tenantId',
        'empty',
        `Outbox ${source} must be non-empty and have no leading or trailing whitespace`,
      );
    }
    if (value.length > MAX_IDENTIFIER_LENGTH) {
      return this.invalid(
        'tenantId',
        'too_long',
        `Outbox ${source} must be at most ${MAX_IDENTIFIER_LENGTH} characters`,
      );
    }
    return value;
  }

  private validateIdentifier(value: unknown, field: string): string {
    if (typeof value !== 'string') {
      return this.invalid(
        field,
        'invalid_type',
        `Outbox ${field} must be a string`,
      );
    }
    if (value.length === 0 || value.trim() !== value) {
      return this.invalid(
        field,
        'empty',
        `Outbox ${field} must be non-empty and have no leading or trailing whitespace`,
      );
    }
    if (value.length > MAX_IDENTIFIER_LENGTH) {
      return this.invalid(
        field,
        'too_long',
        `Outbox ${field} must be at most ${MAX_IDENTIFIER_LENGTH} characters`,
      );
    }
    return value;
  }

  private validateOptionalIdentifier(
    value: unknown,
    field: string,
  ): string | null {
    if (value === undefined || value === null) return null;
    return this.validateIdentifier(value, field);
  }

  private validateOccurredAt(value: unknown): Date | null {
    if (value === undefined || value === null) return null;
    if (!(value instanceof Date)) {
      return this.invalid(
        'occurredAt',
        'invalid_type',
        'Outbox occurredAt must be a Date',
      );
    }
    if (!Number.isFinite(value.getTime())) {
      return this.invalid(
        'occurredAt',
        'invalid_date',
        'Outbox occurredAt must be a valid Date',
      );
    }
    return new Date(value.getTime());
  }

  private normalizeHeaders(value: unknown): {
    value: Record<string, string>;
    json: string;
  } {
    const headers = value ?? {};
    if (!this.isPlainObject(headers)) {
      return this.invalid(
        'headers',
        'invalid_type',
        'Outbox headers must be a plain object of string values',
      );
    }
    if (
      Object.getOwnPropertySymbols(headers).some((symbol) =>
        Object.prototype.propertyIsEnumerable.call(headers, symbol),
      )
    ) {
      return this.invalid(
        'headers',
        'unsupported_json_value',
        'Outbox headers must not contain enumerable symbol keys',
      );
    }

    const normalized: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const key of Object.keys(headers)) {
      this.validateIdentifier(key, `headers.${key || '<empty>'}`);
      const headerValue = (headers as Record<string, unknown>)[key];
      if (typeof headerValue !== 'string') {
        return this.invalid(
          `headers.${key}`,
          'invalid_type',
          `Outbox header "${key}" must be a string`,
        );
      }
      if (headerValue.length > MAX_HEADER_VALUE_LENGTH) {
        return this.invalid(
          `headers.${key}`,
          'too_long',
          `Outbox header "${key}" must be at most ${MAX_HEADER_VALUE_LENGTH} characters`,
        );
      }
      normalized[key] = headerValue;
    }

    const json = JSON.stringify(normalized);
    if (Buffer.byteLength(json, 'utf8') > MAX_HEADERS_BYTES) {
      return this.invalid(
        'headers',
        'too_large',
        `Outbox headers must serialize to at most ${MAX_HEADERS_BYTES} bytes`,
      );
    }
    return { value: normalized, json };
  }

  private normalizeJsonObject(
    value: unknown,
    field: string,
    maxBytes: number,
  ): { value: Record<string, unknown>; json: string } {
    if (!this.isPlainObject(value)) {
      return this.invalid(
        field,
        'invalid_type',
        `Outbox ${field} must be a plain JSON object`,
      );
    }
    const normalized = this.normalizeJsonValue(
      value,
      field,
      new Set<object>(),
      0,
    ) as Record<string, unknown>;
    const json = JSON.stringify(normalized);
    if (Buffer.byteLength(json, 'utf8') > maxBytes) {
      return this.invalid(
        field,
        'too_large',
        `Outbox ${field} must serialize to at most ${maxBytes} bytes`,
      );
    }
    return { value: normalized, json };
  }

  private normalizeJsonValue(
    value: unknown,
    path: string,
    ancestors: Set<object>,
    depth: number,
  ): unknown {
    if (depth > MAX_JSON_DEPTH) {
      return this.invalid(
        path,
        'too_deep',
        `Outbox JSON must not exceed ${MAX_JSON_DEPTH} nested levels`,
      );
    }
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    ) {
      return value;
    }
    if (typeof value === 'number') {
      if (Number.isFinite(value)) return value;
      return this.invalid(
        path,
        'unsupported_json_value',
        `Outbox ${path} must contain only finite JSON numbers`,
      );
    }
    if (typeof value !== 'object') {
      return this.invalid(
        path,
        'unsupported_json_value',
        `Outbox ${path} contains a value that JSON cannot represent`,
      );
    }
    if (value instanceof Date) {
      return this.invalid(
        path,
        Number.isFinite(value.getTime())
          ? 'unsupported_json_value'
          : 'invalid_date',
        `Outbox ${path} must not contain Date objects`,
      );
    }
    if (ancestors.has(value)) {
      return this.invalid(
        path,
        'circular',
        `Outbox ${path} contains a circular reference`,
      );
    }
    if (!Array.isArray(value) && !this.isPlainObject(value)) {
      return this.invalid(
        path,
        'unsupported_json_value',
        `Outbox ${path} must contain only plain JSON objects and arrays`,
      );
    }
    if (
      Object.getOwnPropertySymbols(value).some((symbol) =>
        Object.prototype.propertyIsEnumerable.call(value, symbol),
      )
    ) {
      return this.invalid(
        path,
        'unsupported_json_value',
        `Outbox ${path} must not contain enumerable symbol keys`,
      );
    }

    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const keys = Object.keys(value);
        const hasOnlyIndexes = keys.every(
          (key) =>
            /^(0|[1-9]\d*)$/.test(key) &&
            Number(key) < value.length &&
            String(Number(key)) === key,
        );
        if (keys.length !== value.length || !hasOnlyIndexes) {
          return this.invalid(
            path,
            'unsupported_json_value',
            `Outbox ${path} arrays must be dense and contain no extra properties`,
          );
        }
        return value.map((item, index) =>
          this.normalizeJsonValue(
            item,
            `${path}[${index}]`,
            ancestors,
            depth + 1,
          ),
        );
      }

      const normalized: Record<string, unknown> = Object.create(null) as Record<
        string,
        unknown
      >;
      for (const key of Object.keys(value)) {
        let child: unknown;
        try {
          child = (value as Record<string, unknown>)[key];
        } catch {
          return this.invalid(
            `${path}.${key}`,
            'unsupported_json_value',
            `Outbox ${path}.${key} could not be read as JSON`,
          );
        }
        normalized[key] = this.normalizeJsonValue(
          child,
          `${path}.${key}`,
          ancestors,
          depth + 1,
        );
      }
      return normalized;
    } finally {
      ancestors.delete(value);
    }
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  private invalid<T = never>(
    field: string,
    reason: OutboxEnvelopeErrorReason,
    message: string,
  ): T {
    throw new OutboxEnvelopeError(field, reason, message);
  }

  private resolveTenantProvider(): OutboxTenantProvider | undefined {
    if (this.tenantProvider) return this.tenantProvider;

    const provider = this.options.tenancy?.provider;
    if (provider && typeof provider !== 'function') return provider;

    return undefined;
  }

  private async runOnEmitHook(row: PreparedOutboxRow): Promise<void> {
    const hook = this.options.hooks?.onEmit;
    if (!hook) return;

    const context: OutboxEmitContext = structuredClone({
      eventType: row.eventType,
      payload: row.payload,
      tenantId: row.tenantId,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      partitionKey: row.partitionKey,
      idempotencyKey: row.idempotencyKey,
      correlationId: row.correlationId,
      causationId: row.causationId,
      headers: row.headers,
      occurredAt: row.occurredAt,
    });

    try {
      await hook(context);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`Outbox onEmit hook failed: ${err.message}`);
    }
  }

  private async notify(
    tx: PrismaTransactionClient,
    payload: string,
  ): Promise<void> {
    if (!this.options.wakeup?.enabled) return;

    const channel = this.options.wakeup.channel ?? DEFAULT_WAKEUP_CHANNEL;
    await tx.$executeRaw`
      SELECT pg_notify(${channel}, ${payload})
    `;
  }
}
