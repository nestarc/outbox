import type { ModuleMetadata, Type } from '@nestjs/common';
import type { OutboxHooks } from './outbox-hooks.interface';
import type { OutboxPublisher } from './outbox-publisher.interface';
import type { OutboxTenancyOptions } from './outbox-tenancy.interface';
import type { OutboxTransport } from './outbox-transport.interface';
import type { OutboxWakeupOptions } from './outbox-wakeup.interface';

export interface OutboxPollingOptions {
  enabled?: boolean;
  interval?: number;
  batchSize?: number;
}

export interface OutboxRetryOptions {
  maxRetries?: number;
  backoff?: 'fixed' | 'exponential';
  initialDelay?: number;
}

export interface OutboxDeliveryOptions {
  mode?: 'local' | 'publisher';
}

export interface OutboxLeaseOptions {
  /** Claim lifetime in milliseconds. Defaults to stuckThreshold or 300000. */
  duration?: number;
  /** Active callback heartbeat interval in milliseconds. Defaults to duration / 3. */
  heartbeatInterval?: number;
  /** Consecutive heartbeat errors tolerated before abandoning the claim. Defaults to 1. */
  heartbeatFailureTolerance?: number;
}

export interface OutboxOptions {
  /**
   * forRoot: PrismaService class reference (resolved via DI, must be in a @Global module).
   * forRootAsync: resolved PrismaService instance from the factory.
   * The instance must satisfy {@link PrismaLike} ($executeRaw, $queryRaw).
   */
  prisma: any;
  polling?: OutboxPollingOptions;
  retry?: OutboxRetryOptions;
  /** Custom transport class. Defaults to LocalTransport (in-process handler invocation). */
  transport?: Type<OutboxTransport | OutboxPublisher>;
  delivery?: OutboxDeliveryOptions;
  tenancy?: OutboxTenancyOptions;
  hooks?: OutboxHooks;
  wakeup?: OutboxWakeupOptions;
  lease?: OutboxLeaseOptions;
  events?: Type[];
  isGlobal?: boolean;
  /** @deprecated Use lease.duration. Retained as a lease-duration compatibility alias. */
  stuckThreshold?: number;
}

export interface OutboxAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: any[];
  useFactory?: (...args: any[]) => OutboxOptions | Promise<OutboxOptions>;
  useClass?: Type<OutboxOptionsFactory>;
  useExisting?: Type<OutboxOptionsFactory>;
  /** Custom transport class. Defaults to LocalTransport. */
  transport?: Type<OutboxTransport | OutboxPublisher>;
  isGlobal?: boolean;
}

export interface OutboxOptionsFactory {
  createOutboxOptions(): OutboxOptions | Promise<OutboxOptions>;
}
