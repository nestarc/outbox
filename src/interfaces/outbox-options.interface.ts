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
  prisma: any;
  polling?: OutboxPollingOptions;
  retry?: OutboxRetryOptions;
  events?: Type[];
  isGlobal?: boolean;
  stuckThreshold?: number;
}

export interface OutboxAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: any[];
  useFactory?: (...args: any[]) => OutboxOptions | Promise<OutboxOptions>;
  useClass?: Type<OutboxOptionsFactory>;
  useExisting?: Type<OutboxOptionsFactory>;
  isGlobal?: boolean;
}

export interface OutboxOptionsFactory {
  createOutboxOptions(): OutboxOptions | Promise<OutboxOptions>;
}
