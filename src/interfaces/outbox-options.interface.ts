import type { ModuleMetadata, Type } from '@nestjs/common';

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
  transport?: Type;
  events?: Type[];
  isGlobal?: boolean;
  stuckThreshold?: number;
}

export interface OutboxAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: any[];
  useFactory?: (...args: any[]) => OutboxOptions | Promise<OutboxOptions>;
  useClass?: Type<OutboxOptionsFactory>;
  useExisting?: Type<OutboxOptionsFactory>;
  /** Custom transport class. Defaults to LocalTransport. */
  transport?: Type;
  isGlobal?: boolean;
}

export interface OutboxOptionsFactory {
  createOutboxOptions(): OutboxOptions | Promise<OutboxOptions>;
}
