import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  DEFAULT_BACKOFF,
  DEFAULT_BATCH_SIZE,
  DEFAULT_HEARTBEAT_FAILURE_TOLERANCE,
  DEFAULT_INITIAL_DELAY,
  DEFAULT_MAX_RETRY_DELAY,
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
import {
  type ClaimedOutboxRecord,
  parseClaimedOutboxRecord,
  validateDeliveryTransport,
  validateOutboxOptions,
} from './outbox-invariants';
import { OutboxSchemaGuard } from './outbox.schema';

const POLL_INTERVAL_NAME = 'outbox-poll';

interface LeaseHeartbeat {
  stop(): Promise<boolean>;
}

type DispatchResult = 'dispatched' | 'no-handler' | 'lost-claim';
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
  private pollCoordinator: Promise<void> | null = null;
  private pollRerunRequested = false;

  private readonly pollingEnabled: boolean;
  private readonly interval: number;
  private readonly batchSize: number;
  private readonly backoff: 'fixed' | 'exponential';
  private readonly initialDelay: number;
  private readonly maxDelay: number;
  private readonly leaseDuration: number;
  private readonly heartbeatInterval: number;
  private readonly heartbeatFailureTolerance: number;
  private readonly deliveryMode: 'local' | 'publisher';

  constructor(
    @Inject(OUTBOX_OPTIONS) private readonly options: OutboxOptions,
    @Inject(OUTBOX_TRANSPORT)
    private readonly transport: OutboxTransport | OutboxPublisher,
    private readonly explorer: OutboxExplorer,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Optional() private readonly schemaGuard?: OutboxSchemaGuard,
  ) {
    validateOutboxOptions(options);
    validateDeliveryTransport(options, transport);
    this.pollingEnabled = options.polling?.enabled ?? true;
    this.interval = options.polling?.interval ?? DEFAULT_POLLING_INTERVAL;
    this.batchSize = options.polling?.batchSize ?? DEFAULT_BATCH_SIZE;
    this.backoff = options.retry?.backoff ?? DEFAULT_BACKOFF;
    this.initialDelay = options.retry?.initialDelay ?? DEFAULT_INITIAL_DELAY;
    this.maxDelay = options.retry?.maxDelay ?? DEFAULT_MAX_RETRY_DELAY;
    this.leaseDuration =
      options.lease?.duration ??
      options.stuckThreshold ??
      DEFAULT_STUCK_THRESHOLD;
    this.heartbeatInterval =
      options.lease?.heartbeatInterval ??
      Math.max(1, Math.floor(this.leaseDuration / 3));
    this.heartbeatFailureTolerance =
      options.lease?.heartbeatFailureTolerance ??
      DEFAULT_HEARTBEAT_FAILURE_TOLERANCE;
    this.deliveryMode = options.delivery?.mode ?? 'local';
  }

  async onModuleInit(): Promise<void> {
    if (this.schemaGuard) await this.schemaGuard.assertCompatible();
    if (!this.pollingEnabled) return;

    const interval = setInterval(() => this.requestPoll(), this.interval);
    this.schedulerRegistry.addInterval(POLL_INTERVAL_NAME, interval);
    this.logger.log(
      `Outbox poller started (interval: ${this.interval}ms, batch: ${this.batchSize})`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.pollRerunRequested = false;

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

  poll(): Promise<void> {
    return this.schedulePoll() ?? Promise.resolve();
  }

  requestPoll(): void {
    const alreadyRunning = this.pollCoordinator !== null;
    const coordinator = this.schedulePoll();
    if (!coordinator || alreadyRunning) return;

    void coordinator.catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`Outbox background poll failed: ${err.message}`);
    });
  }

  private schedulePoll(): Promise<void> | null {
    if (this.isShuttingDown) return null;

    if (this.pollCoordinator) {
      this.pollRerunRequested = true;
      return this.pollCoordinator;
    }

    let resolveCoordinator!: () => void;
    let rejectCoordinator!: (error: unknown) => void;
    const coordinator = new Promise<void>((resolve, reject) => {
      resolveCoordinator = resolve;
      rejectCoordinator = reject;
    });
    this.pollCoordinator = coordinator;
    void this.drainPolls().then(
      () => {
        this.finishPoll(coordinator);
        resolveCoordinator();
      },
      (error: unknown) => {
        this.finishPoll(coordinator);
        rejectCoordinator(error);
      },
    );
    return coordinator;
  }

  private finishPoll(coordinator: Promise<void>): void {
    if (this.pollCoordinator === coordinator) {
      this.pollCoordinator = null;
    }
  }

  private async drainPolls(): Promise<void> {
    let firstError: unknown;
    let failed = false;

    do {
      this.pollRerunRequested = false;
      try {
        await this.pollOnce();
      } catch (error) {
        if (!failed) {
          firstError = error;
          failed = true;
        }
      }
    } while (this.pollRerunRequested && !this.isShuttingDown);

    if (failed) {
      throw firstError;
    }
  }

  private async pollOnce(): Promise<void> {
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

      for (let processed = 0; processed < this.batchSize; processed++) {
        const [record] = await this.fetchAndLock();
        if (!record) break;

        if (this.isShuttingDown) {
          await this.releaseClaim(record);
          break;
        }

        await this.processRecord(record);
      }
    } finally {
      this.pollInFlight--;
    }
  }

  private async processRecord(record: ClaimedOutboxRecord): Promise<void> {
    this.activeCount++;
    const startedAt = Date.now();
    const heartbeat = this.startLeaseHeartbeat(record);
    try {
      let dispatchResult: DispatchResult;
      let dispatchError: Error | null = null;
      try {
        await this.runHook(
          'onDispatchStart',
          this.createDispatchContext(record),
        );
        dispatchResult = await this.dispatchRecord(record);
      } catch (error) {
        dispatchResult = 'lost-claim';
        dispatchError =
          error instanceof Error ? error : new Error(String(error));
      }

      const leaseHealthy = await heartbeat.stop();
      if (!leaseHealthy) {
        this.logger.warn(
          `Lost lease for event ${record.id}; completion was discarded`,
        );
        return;
      }

      if (dispatchError) {
        await this.transitionFailure(record, dispatchError, startedAt);
        return;
      }

      if (dispatchResult === 'no-handler') {
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
        return;
      }

      if (dispatchResult === 'dispatched' && (await this.markSent(record))) {
        await this.runHook('onDispatchSuccess', {
          ...this.createDispatchContext(record),
          durationMs: Date.now() - startedAt,
        });
      }
    } finally {
      await heartbeat.stop();
      this.activeCount--;
    }
  }

  private async transitionFailure(
    record: ClaimedOutboxRecord,
    error: Error,
    startedAt: number,
  ): Promise<void> {
    const transition = await this.handleFailure(record, error);
    if (transition === 'lost-claim') return;

    await this.runHook('onDispatchFailure', {
      ...this.createDispatchContext(record),
      error,
      durationMs: Date.now() - startedAt,
    });
    const retryContext = this.createRetryContext(
      record,
      error,
      record.retryCount + 1,
    );
    await this.runHook(
      transition === 'dead-letter' ? 'onDeadLetter' : 'onRetryScheduled',
      retryContext,
    );
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
      return 'no-handler';
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
    const leaseDurationSeconds = this.leaseDuration / 1000;

    const rows: unknown[] = await prisma.$queryRaw`
      UPDATE outbox_events
      SET status = 'PROCESSING',
          claim_token = gen_random_uuid(),
          lease_expires_at = NOW() + make_interval(secs => ${leaseDurationSeconds}),
          updated_at = NOW()
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE status = 'PENDING'
          AND (
            (retry_count = 0 AND next_attempt_at IS NULL)
            OR next_attempt_at <= NOW()
          )
        ORDER BY created_at ASC
        LIMIT 1
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
        next_attempt_at AS "nextAttemptAt",
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
        claim_token AS "claimToken",
        lease_expires_at AS "leaseExpiresAt"
    `;
    return rows.map(parseClaimedOutboxRecord);
  }

  private async markSent(record: ClaimedOutboxRecord): Promise<boolean> {
    const prisma = this.options.prisma;
    const updated = await prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'SENT',
          claim_token = NULL,
          lease_expires_at = NULL,
          processed_at = NOW(),
          next_attempt_at = NULL,
          updated_at = NOW()
      WHERE id = ${record.id}::uuid
        AND status = 'PROCESSING'
        AND claim_token = ${record.claimToken}::uuid
        AND lease_expires_at > NOW()
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
          lease_expires_at = NULL,
          last_error = ${errorMessage},
          next_attempt_at = NULL,
          updated_at = NOW()
      WHERE id = ${record.id}::uuid
        AND status = 'PROCESSING'
        AND claim_token = ${record.claimToken}::uuid
        AND lease_expires_at > NOW()
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
            lease_expires_at = NULL,
            retry_count = ${newRetryCount},
            last_error = ${errorMessage},
            next_attempt_at = NULL,
            updated_at = NOW()
        WHERE id = ${record.id}::uuid
          AND status = 'PROCESSING'
          AND claim_token = ${record.claimToken}::uuid
          AND lease_expires_at > NOW()
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
      const retryDelaySeconds =
        this.calculateRetryDelayMs(newRetryCount) / 1000;
      const updated = await prisma.$executeRaw`
        UPDATE outbox_events
        SET status = 'PENDING',
            claim_token = NULL,
            lease_expires_at = NULL,
            retry_count = ${newRetryCount},
            last_error = ${errorMessage},
            next_attempt_at = NOW() + make_interval(secs => ${retryDelaySeconds}),
            updated_at = NOW()
        WHERE id = ${record.id}::uuid
          AND status = 'PROCESSING'
          AND claim_token = ${record.claimToken}::uuid
          AND lease_expires_at > NOW()
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

  private startLeaseHeartbeat(record: ClaimedOutboxRecord): LeaseHeartbeat {
    let stopped = false;
    let healthy = true;
    let consecutiveFailures = 0;
    let inFlight: Promise<void> | null = null;

    const heartbeat = async (): Promise<void> => {
      try {
        const renewed = await this.renewLease(record);
        if (!renewed) {
          healthy = false;
          this.logger.warn(`Lost lease heartbeat claim for event ${record.id}`);
          return;
        }
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures++;
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          `Lease heartbeat failed for event ${record.id} ` +
            `(${consecutiveFailures}/${this.heartbeatFailureTolerance + 1}): ${err.message}`,
        );
        if (consecutiveFailures > this.heartbeatFailureTolerance) {
          healthy = false;
        }
      }
    };

    const interval = setInterval(() => {
      if (stopped || !healthy || inFlight) return;
      inFlight = heartbeat().finally(() => {
        inFlight = null;
      });
    }, this.heartbeatInterval);
    interval.unref?.();

    return {
      stop: async (): Promise<boolean> => {
        if (!stopped) {
          stopped = true;
          clearInterval(interval);
        }
        if (inFlight) await inFlight;
        return healthy;
      },
    };
  }

  private async renewLease(record: ClaimedOutboxRecord): Promise<boolean> {
    const prisma = this.options.prisma;
    const leaseDurationSeconds = this.leaseDuration / 1000;
    const updated = await prisma.$executeRaw`
      UPDATE outbox_events
      SET lease_expires_at = NOW() + make_interval(secs => ${leaseDurationSeconds}),
          updated_at = NOW()
      WHERE id = ${record.id}::uuid
        AND status = 'PROCESSING'
        AND claim_token = ${record.claimToken}::uuid
        AND lease_expires_at > NOW()
    `;
    return updated === 1;
  }

  private async releaseClaim(record: ClaimedOutboxRecord): Promise<void> {
    const prisma = this.options.prisma;
    const released = await prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'PENDING',
          claim_token = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
      WHERE id = ${record.id}::uuid
        AND status = 'PROCESSING'
        AND claim_token = ${record.claimToken}::uuid
    `;
    if (released === 0) {
      this.logger.warn(
        `Lost claim for event ${record.id} before shutdown release`,
      );
    }
  }

  private async recoverStuckEvents(): Promise<void> {
    const prisma = this.options.prisma;
    const legacyThresholdSeconds = this.leaseDuration / 1000;

    const recovered = await prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'PENDING',
          claim_token = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
      WHERE status = 'PROCESSING'
        AND (
          lease_expires_at <= NOW()
          OR (
            lease_expires_at IS NULL
            AND updated_at <= NOW() - make_interval(secs => ${legacyThresholdSeconds})
          )
        )
    `;

    if (recovered > 0) {
      this.logger.warn(
        `Recovered ${recovered} events with expired PROCESSING leases`,
      );
    }
  }

  private calculateRetryDelayMs(retryCount: number): number {
    if (!Number.isSafeInteger(retryCount) || retryCount < 1) {
      throw new Error(
        'Outbox persisted retry_count must be a positive safe integer when scheduling a retry',
      );
    }
    if (this.backoff === 'fixed' || this.initialDelay === 0) {
      return this.initialDelay;
    }

    const exponent = retryCount - 1;
    const maximumUncappedExponent = Math.floor(
      Math.log2(this.maxDelay / this.initialDelay),
    );
    if (exponent > maximumUncappedExponent) return this.maxDelay;

    const delay = this.initialDelay * 2 ** exponent;
    if (!Number.isSafeInteger(delay) || delay > this.maxDelay) {
      throw new Error('Outbox retry delay calculation exceeded its safe bound');
    }
    return delay;
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
      nextAttemptAt: record.nextAttemptAt,
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
