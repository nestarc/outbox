import type { Type } from '@nestjs/common';

export interface OutboxTenantProvider {
  getTenantId?(): string | null | undefined | Promise<string | null | undefined>;
  runWithTenant?<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
}

export interface OutboxTenancyOptions {
  provider?: Type<OutboxTenantProvider> | OutboxTenantProvider;
}
