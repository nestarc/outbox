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

    await this.notify(tx, row.eventType);
    await this.runOnEmitHook(row);
  }

  async emitMany(
    tx: PrismaTransactionClient,
    events: OutboxEmitManyEntry[],
  ): Promise<void> {
    if (events.length === 0) return;

    if (!tx.$executeRawUnsafe) {
      for (const entry of events) {
        const normalized = this.normalizeEntry(entry);
        await this.emit(tx, normalized.event, normalized.options);
      }
      return;
    }

    const rows = await Promise.all(
      events.map((entry) => {
        const normalized = this.normalizeEntry(entry);
        return this.prepareRow(normalized.event, normalized.options);
      }),
    );

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

    await tx.$executeRawUnsafe(
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

    await this.notify(tx, rows[0]?.eventType ?? 'outbox.events');

    for (const row of rows) {
      await this.runOnEmitHook(row);
    }
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
    const payload = event.toPayload();
    const headers = options?.headers ?? {};

    return {
      eventType: event.getEventType(),
      payload,
      payloadJson: JSON.stringify(payload),
      maxRetries: this.maxRetries,
      tenantId: await this.resolveTenantId(options),
      aggregateType: options?.aggregateType ?? null,
      aggregateId: options?.aggregateId ?? null,
      partitionKey: options?.partitionKey ?? null,
      idempotencyKey: options?.idempotencyKey ?? null,
      correlationId: options?.correlationId ?? null,
      causationId: options?.causationId ?? null,
      headers,
      headersJson: JSON.stringify(headers),
      occurredAt: options?.occurredAt ?? null,
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
        throw new Error('Outbox tenantScope must be "global" when provided');
      }
      if (tenantId !== undefined) {
        throw new Error(
          'Outbox emit options cannot combine tenantId with tenantScope',
        );
      }
      return null;
    }

    if (tenantId === null) {
      throw new Error(
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
        throw new Error(
          'Outbox tenancy policy "require-match" requires a provider tenantId',
        );
      }
      if (providerTenantId !== explicitTenantId) {
        throw new Error(
          'Outbox explicit tenantId does not match the provider tenantId',
        );
      }
      return explicitTenantId;
    }

    const providerTenantId = await this.getProviderTenantId();
    if (providerTenantId !== null) return providerTenantId;

    if (policy === 'optional') return null;

    throw new Error(
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
      throw new Error(
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
      throw new Error(`Outbox ${source} must be a string`);
    }
    if (value.length === 0 || value.trim() !== value) {
      throw new Error(
        `Outbox ${source} must be non-empty and have no leading or trailing whitespace`,
      );
    }
    return value;
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

    const context: OutboxEmitContext = {
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
    };

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
