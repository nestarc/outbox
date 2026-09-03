import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  DEFAULT_BACKOFF,
  DEFAULT_BATCH_SIZE,
  DEFAULT_INITIAL_DELAY,
  DEFAULT_POLLING_INTERVAL,
  DEFAULT_SHUTDOWN_TIMEOUT,
  DEFAULT_STUCK_THRESHOLD,
  OUTBOX_OPTIONS,
  OUTBOX_TRANSPORT,
  STUCK_RECOVERY_INTERVAL,
} from './outbox.constants';
import type { OutboxHandlerContext } from './interfaces/outbox-handler-context.interface';
import type {
  OutboxDispatchContext,
  OutboxHooks,
  OutboxRetryContext,
} from './interfaces/outbox-hooks.interface';
import type { OutboxOptions } from './interfaces/outbox-options.interface';
import type { OutboxRecord } from './interfaces/outbox-record.interface';
import type { OutboxPublisher } from './interfaces/outbox-publisher.interface';
import type { OutboxTransport } from './interfaces/outbox-transport.interface';
import { OutboxExplorer } from './outbox.explorer';

const POLL_INTERVAL_NAME = 'outbox-poll';

interface ClaimedOutboxRecord extends OutboxRecord {
  readonly claimToken: string;
}

type DispatchResult = 'dispatched' | 'terminal' | 'lost-claim';
type FailureTransition = 'retry' | 'dead-letter' | 'lost-claim';

function hasPublish(transport: unknown): transport is OutboxPublisher {
  return (
    typeof transport === 'object' &&
    transport !== null &&
    typeof (transport as { publish?: unknown }).publish === 'function'
  );
}

function hasDispatch(transport: unknown): transport is OutboxTransport {
  return (
    typeof transport === 'object' &&
    transport !== null &&
    typeof (transport as { dispatch?: unknown }).dispatch === 'function'
  );
}

@Injectable()
export class OutboxPoller implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPoller.name);
  private isShuttingDown = false;
  private activeCount = 0;
  private pollInFlight = 0;
  private pollCount = 0;

  private readonly pollingEnabled: boolean;
  private readonly interval: number;
  private readonly batchSize: number;
  private readonly backoff: 'fixed' | 'exponential';
  private readonly initialDelay: number;
  private readonly stuckThreshold: number;
  private readonly deliveryMode: 'local' | 'publisher';

  constructor(
    @Inject(OUTBOX_OPTIONS) private readonly options: OutboxOptions,
    @Inject(OUTBOX_TRANSPORT)
    private readonly transport: OutboxTransport | OutboxPublisher,
    private readonly explorer: OutboxExplorer,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.pollingEnabled = options.polling?.enabled ?? true;
    this.interval = options.polling?.interval ?? DEFAULT_POLLING_INTERVAL;
    this.batchSize = options.polling?.batchSize ?? DEFAULT_BATCH_SIZE;
    this.backoff = options.retry?.backoff ?? DEFAULT_BACKOFF;
    this.initialDelay = options.retry?.initialDelay ?? DEFAULT_INITIAL_DELAY;
    this.stuckThreshold = options.stuckThreshold ?? DEFAULT_STUCK_THRESHOLD;
    this.deliveryMode = options.delivery?.mode ?? 'local';
  }

  onModuleInit(): void {
    if (!this.pollingEnabled) return;

    const interval = setInterval(() => this.poll(), this.interval);
    this.schedulerRegistry.addInterval(POLL_INTERVAL_NAME, interval);
    this.logger.log(
      `Outbox poller started (interval: ${this.interval}ms, batch: ${this.batchSize})`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.isShuttingDown = true;

    try {
      this.schedulerRegistry.deleteInterval(POLL_INTERVAL_NAME);
    } catch {
      // Interval might not exist if polling was disabled
    }

    const start = Date.now();
    while (
      (this.pollInFlight > 0 || this.activeCount > 0) &&
      Date.now() - start < DEFAULT_SHUTDOWN_TIMEOUT
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (this.pollInFlight > 0 || this.activeCount > 0) {
      this.logger.warn(
        `Shutdown timeout: ${this.pollInFlight} polls, ${this.activeCount} events still in flight`,
      );
    }
  }

  async poll(): Promise<void> {
    if (this.isShuttingDown) return;

    this.pollInFlight++;
    try {
      this.pollCount++;

      if (this.pollCount % STUCK_RECOVERY_INTERVAL === 0) {
        await this.recoverStuckEvents();
      }

      await this.runHook('onPollStart', {
        batchSize: this.batchSize,
        deliveryMode: this.deliveryMode,
      });

      const records = await this.fetchAndLock();

      for (const record of records) {
        if (this.isShuttingDown) break;

        this.activeCount++;
        const startedAt = Date.now();
        try {
          await this.runHook(
            'onDispatchStart',
            this.createDispatchContext(record),
          );
          const dispatched = await this.dispatchRecord(record);
          if (dispatched === 'dispatched' && (await this.markSent(record))) {
            await this.runHook('onDispatchSuccess', {
              ...this.createDispatchContext(record),
              durationMs: Date.now() - startedAt,
            });
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          const transition = await this.handleFailure(record, err);
          if (transition !== 'lost-claim') {
            await this.runHook('onDispatchFailure', {
              ...this.createDispatchContext(record),
              error: err,
              durationMs: Date.now() - startedAt,
            });
            const retryContext = this.createRetryContext(
              record,
              err,
              record.retryCount + 1,
            );
            await this.runHook(
              transition === 'dead-letter'
                ? 'onDeadLetter'
                : 'onRetryScheduled',
              retryContext,
            );
          }
        } finally {
          this.activeCount--;
        }
      }
    } finally {
      this.pollInFlight--;
    }
  }

  private async dispatchRecord(
    record: ClaimedOutboxRecord,
  ): Promise<DispatchResult> {
    if (this.deliveryMode === 'publisher') {
      if (hasPublish(this.transport)) {
        await this.transport.publish(this.createRecordSnapshot(record));
        return 'dispatched';
      }

      if (hasDispatch(this.transport)) {
        await this.transport.dispatch(this.createRecordSnapshot(record), []);
        return 'dispatched';
      }

      throw new Error(
        'Outbox publisher mode requires a transport with publish(record) or dispatch(record, handlers)',
      );
    }

    const handlers = this.explorer.getHandlers(record.eventType);

    if (handlers.length === 0) {
      const errorMessage = `No registered handlers for event type "${record.eventType}"`;
      const transitioned = await this.markFailed(record, errorMessage);
      if (transitioned) {
        this.logger.error(
          `No handlers for event type "${record.eventType}", marked as FAILED`,
        );
      } else {
        this.logger.warn(
          `Lost claim for event ${record.id} before marking it as FAILED`,
        );
      }
      return transitioned ? 'terminal' : 'lost-claim';
    }

    if (!hasDispatch(this.transport)) {
      throw new Error(
        'Outbox local mode requires a transport with dispatch(record, handlers)',
      );
    }

    const dispatchRecord = this.createRecordSnapshot(record);
    const contextRecord = this.createRecordSnapshot(record);
    await this.transport.dispatch(
      dispatchRecord,
      handlers,
      this.createHandlerContext(contextRecord),
    );
    return 'dispatched';
  }

  private async fetchAndLock(): Promise<ClaimedOutboxRecord[]> {
    const prisma = this.options.prisma;
    const backoffType = this.backoff;
    const initialDelaySeconds = this.initialDelay / 1000;
    const batchSize = this.batchSize;

    return prisma.$queryRaw`
      UPDATE outbox_events
      SET status = 'PROCESSING',
          claim_token = gen_random_uuid(),
          updated_at = NOW()
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE status = 'PENDING'
          AND (
            retry_count = 0
            OR updated_at < NOW() - make_interval(
              secs => CASE
                WHEN ${backoffType} = 'exponential'
                THEN ${initialDelaySeconds} * pow(2, retry_count - 1)
                ELSE ${initialDelaySeconds}
              END
            )
          )
        ORDER BY created_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING
        id,
        event_type AS "eventType",
        payload,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        processed_at AS "processedAt",
        retry_count AS "retryCount",
        max_retries AS "maxRetries",
        last_error AS "lastError",
        tenant_id AS "tenantId",
        aggregate_type AS "aggregateType",
        aggregate_id AS "aggregateId",
        partition_key AS "partitionKey",
        idempotency_key AS "idempotencyKey",
        correlation_id AS "correlationId",
        causation_id AS "causationId",
        headers,
        occurred_at AS "occurredAt",
        claim_token AS "claimToken"
    `;
  }

  private async markSent(record: ClaimedOutboxRecord): Promise<boolean> {
    const prisma = this.options.prisma;
    const updated = await prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'SENT',
          claim_token = NULL,
          processed_at = NOW(),
          updated_at = NOW()
      WHERE id = ${record.id}::uuid
        AND status = 'PROCESSING'
        AND claim_token = ${record.claimToken}::uuid
    `;
    if (updated === 0) {
      this.logger.warn(
        `Lost claim for event ${record.id} before marking it as SENT`,
      );
    }
    return updated === 1;
  }

  private async markFailed(
    record: ClaimedOutboxRecord,
    errorMessage: string,
  ): Promise<boolean> {
    const prisma = this.options.prisma;
    const updated = await prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'FAILED',
          claim_token = NULL,
          last_error = ${errorMessage},
          updated_at = NOW()
      WHERE id = ${record.id}::uuid
        AND status = 'PROCESSING'
        AND claim_token = ${record.claimToken}::uuid
    `;
    return updated === 1;
  }

  private async handleFailure(
    record: ClaimedOutboxRecord,
    error: Error,
  ): Promise<FailureTransition> {
    const newRetryCount = record.retryCount + 1;
    const prisma = this.options.prisma;
    const errorMessage = error.message;

    if (newRetryCount >= record.maxRetries) {
      const updated = await prisma.$executeRaw`
        UPDATE outbox_events
        SET status = 'FAILED',
            claim_token = NULL,
            retry_count = ${newRetryCount},
            last_error = ${errorMessage},
            updated_at = NOW()
        WHERE id = ${record.id}::uuid
          AND status = 'PROCESSING'
          AND claim_token = ${record.claimToken}::uuid
      `;
      if (updated === 0) {
        this.logger.warn(
          `Lost claim for event ${record.id} before marking it as FAILED`,
        );
        return 'lost-claim';
      }
      this.logger.error(
        `Event ${record.id} failed permanently after ${newRetryCount} retries: ${errorMessage}`,
      );
      return 'dead-letter';
    } else {
      const updated = await prisma.$executeRaw`
        UPDATE outbox_events
        SET status = 'PENDING',
            claim_token = NULL,
            retry_count = ${newRetryCount},
            last_error = ${errorMessage},
            updated_at = NOW()
        WHERE id = ${record.id}::uuid
          AND status = 'PROCESSING'
          AND claim_token = ${record.claimToken}::uuid
      `;
      if (updated === 0) {
        this.logger.warn(
          `Lost claim for event ${record.id} before scheduling retry ${newRetryCount}`,
        );
        return 'lost-claim';
      }
      this.logger.warn(
        `Event ${record.id} failed (retry ${newRetryCount}/${record.maxRetries}): ${errorMessage}`,
      );
      return 'retry';
    }
  }

  private async recoverStuckEvents(): Promise<void> {
    const prisma = this.options.prisma;
    const thresholdSeconds = this.stuckThreshold / 1000;

    const recovered = await prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'PENDING', claim_token = NULL, updated_at = NOW()
      WHERE status = 'PROCESSING'
        AND updated_at < NOW() - make_interval(secs => ${thresholdSeconds})
    `;

    if (recovered > 0) {
      this.logger.warn(
        `Recovered ${recovered} stuck events from PROCESSING state`,
      );
    }
  }

  private createHandlerContext(record: OutboxRecord): OutboxHandlerContext {
    return {
      record,
      eventId: record.id,
      eventType: record.eventType,
      tenantId: record.tenantId,
      retryCount: record.retryCount,
      headers: record.headers,
    };
  }

  private createDispatchContext(
    record: ClaimedOutboxRecord,
  ): OutboxDispatchContext {
    const snapshot = this.createRecordSnapshot(record);
    return {
      record: snapshot,
      eventId: snapshot.id,
      eventType: snapshot.eventType,
      tenantId: snapshot.tenantId,
      retryCount: snapshot.retryCount,
      maxRetries: snapshot.maxRetries,
      aggregateType: snapshot.aggregateType,
      aggregateId: snapshot.aggregateId,
      partitionKey: snapshot.partitionKey,
      idempotencyKey: snapshot.idempotencyKey,
      correlationId: snapshot.correlationId,
      causationId: snapshot.causationId,
      headers: snapshot.headers,
    };
  }

  private createRetryContext(
    record: ClaimedOutboxRecord,
    error: Error,
    retryCount: number,
  ): OutboxRetryContext {
    return {
      ...this.createDispatchContext(record),
      error,
      retryCount,
      maxRetries: record.maxRetries,
    };
  }

  private createRecordSnapshot(record: ClaimedOutboxRecord): OutboxRecord {
    return structuredClone({
      id: record.id,
      eventType: record.eventType,
      payload: record.payload,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      processedAt: record.processedAt,
      retryCount: record.retryCount,
      maxRetries: record.maxRetries,
      lastError: record.lastError,
      tenantId: record.tenantId,
      aggregateType: record.aggregateType,
      aggregateId: record.aggregateId,
      partitionKey: record.partitionKey,
      idempotencyKey: record.idempotencyKey,
      correlationId: record.correlationId,
      causationId: record.causationId,
      headers: record.headers,
      occurredAt: record.occurredAt,
    });
  }

  private async runHook<K extends keyof OutboxHooks>(
    name: K,
    context: Parameters<NonNullable<OutboxHooks[K]>>[0],
  ): Promise<void> {
    const hook = this.options.hooks?.[name];
    if (!hook) return;

    try {
      await hook(context as never);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`Outbox ${String(name)} hook failed: ${err.message}`);
    }
  }
}
