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
  DEFAULT_MAX_RETRIES,
  DEFAULT_POLLING_INTERVAL,
  DEFAULT_SHUTDOWN_TIMEOUT,
  DEFAULT_STUCK_THRESHOLD,
  OUTBOX_OPTIONS,
  OUTBOX_TRANSPORT,
  STUCK_RECOVERY_INTERVAL,
} from './outbox.constants';
import type { OutboxOptions } from './interfaces/outbox-options.interface';
import type { OutboxRecord } from './interfaces/outbox-record.interface';
import type { OutboxTransport } from './interfaces/outbox-transport.interface';
import { OutboxExplorer } from './outbox.explorer';

const POLL_INTERVAL_NAME = 'outbox-poll';

@Injectable()
export class OutboxPoller implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPoller.name);
  private isShuttingDown = false;
  private activeCount = 0;
  private pollCount = 0;

  private readonly pollingEnabled: boolean;
  private readonly interval: number;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly backoff: 'fixed' | 'exponential';
  private readonly initialDelay: number;
  private readonly stuckThreshold: number;

  constructor(
    @Inject(OUTBOX_OPTIONS) private readonly options: OutboxOptions,
    @Inject(OUTBOX_TRANSPORT) private readonly transport: OutboxTransport,
    private readonly explorer: OutboxExplorer,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.pollingEnabled = options.polling?.enabled ?? true;
    this.interval = options.polling?.interval ?? DEFAULT_POLLING_INTERVAL;
    this.batchSize = options.polling?.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxRetries = options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoff = options.retry?.backoff ?? DEFAULT_BACKOFF;
    this.initialDelay = options.retry?.initialDelay ?? DEFAULT_INITIAL_DELAY;
    this.stuckThreshold = options.stuckThreshold ?? DEFAULT_STUCK_THRESHOLD;
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
      this.activeCount > 0 &&
      Date.now() - start < DEFAULT_SHUTDOWN_TIMEOUT
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (this.activeCount > 0) {
      this.logger.warn(
        `Shutdown timeout: ${this.activeCount} events still processing`,
      );
    }
  }

  async poll(): Promise<void> {
    if (this.isShuttingDown) return;

    this.pollCount++;

    if (this.pollCount % STUCK_RECOVERY_INTERVAL === 0) {
      await this.recoverStuckEvents();
    }

    const records = await this.fetchAndLock();

    for (const record of records) {
      if (this.isShuttingDown) break;

      this.activeCount++;
      try {
        const handlers = this.explorer.getHandlers(record.eventType);

        if (handlers.length === 0) {
          this.logger.warn(
            `No handlers for event type "${record.eventType}", marking as SENT`,
          );
          await this.markSent(record.id);
          continue;
        }

        await this.transport.dispatch(record, handlers);
        await this.markSent(record.id);
      } catch (error) {
        const err =
          error instanceof Error ? error : new Error(String(error));
        await this.handleFailure(record, err);
      } finally {
        this.activeCount--;
      }
    }
  }

  private async fetchAndLock(): Promise<OutboxRecord[]> {
    const prisma = this.options.prisma;
    const backoffType = this.backoff;
    const initialDelaySeconds = this.initialDelay / 1000;
    const batchSize = this.batchSize;

    return prisma.$queryRaw`
      UPDATE outbox_events
      SET status = 'PROCESSING', updated_at = NOW()
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
        tenant_id AS "tenantId"
    `;
  }

  private async markSent(id: string): Promise<void> {
    const prisma = this.options.prisma;
    await prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'SENT', processed_at = NOW(), updated_at = NOW()
      WHERE id = ${id}::uuid
    `;
  }

  private async handleFailure(
    record: OutboxRecord,
    error: Error,
  ): Promise<void> {
    const newRetryCount = record.retryCount + 1;
    const prisma = this.options.prisma;
    const errorMessage = error.message;

    if (newRetryCount >= this.maxRetries) {
      this.logger.error(
        `Event ${record.id} failed permanently after ${newRetryCount} retries: ${errorMessage}`,
      );
      await prisma.$executeRaw`
        UPDATE outbox_events
        SET status = 'FAILED',
            retry_count = ${newRetryCount},
            last_error = ${errorMessage},
            updated_at = NOW()
        WHERE id = ${record.id}::uuid
      `;
    } else {
      this.logger.warn(
        `Event ${record.id} failed (retry ${newRetryCount}/${this.maxRetries}): ${errorMessage}`,
      );
      await prisma.$executeRaw`
        UPDATE outbox_events
        SET status = 'PENDING',
            retry_count = ${newRetryCount},
            last_error = ${errorMessage},
            updated_at = NOW()
        WHERE id = ${record.id}::uuid
      `;
    }
  }

  private async recoverStuckEvents(): Promise<void> {
    const prisma = this.options.prisma;
    const thresholdSeconds = this.stuckThreshold / 1000;

    const recovered = await prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'PENDING', updated_at = NOW()
      WHERE status = 'PROCESSING'
        AND updated_at < NOW() - make_interval(secs => ${thresholdSeconds})
    `;

    if (recovered > 0) {
      this.logger.warn(
        `Recovered ${recovered} stuck events from PROCESSING state`,
      );
    }
  }
}
