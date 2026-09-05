import type { ModuleMetadata, Type } from '@nestjs/common';
import type { OutboxHooks } from './outbox-hooks.interface';
import type { OutboxPublisher } from './outbox-publisher.interface';
import type {
  OutboxTenancyOptions,
  OutboxTenantProvider,
} from './outbox-tenancy.interface';
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
  /** Maximum persisted retry delay in milliseconds. Defaults to 24 hours. */
  maxDelay?: number;
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

/**
 * Runtime values produced by an async options factory. Nest provider
 * registrations are intentionally owned by {@link OutboxAsyncOptions} so
 * their dependencies can participate in the module graph before the factory
 * resolves.
 */
export interface OutboxAsyncRuntimeOptions extends Omit<
  OutboxOptions,
  'isGlobal' | 'tenancy' | 'transport'
> {
  tenancy?: Omit<OutboxTenancyOptions, 'provider'> & { provider?: never };
  isGlobal?: never;
  transport?: never;
}

export interface OutboxAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: any[];
  useFactory?: (
    ...args: any[]
  ) => OutboxAsyncRuntimeOptions | Promise<OutboxAsyncRuntimeOptions>;
  useClass?: Type<OutboxOptionsFactory>;
  useExisting?: Type<OutboxOptionsFactory>;
  /** Nest-created custom transport class. Defaults to LocalTransport. */
  transport?: Type<OutboxTransport | OutboxPublisher>;
  /** Nest-created tenant provider class or an already-created provider value. */
  tenantProvider?: Type<OutboxTenantProvider> | OutboxTenantProvider;
  isGlobal?: boolean;
}

export interface OutboxOptionsFactory {
  createOutboxOptions():
    | OutboxAsyncRuntimeOptions
    | Promise<OutboxAsyncRuntimeOptions>;
}
