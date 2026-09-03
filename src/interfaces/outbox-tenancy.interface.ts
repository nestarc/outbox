import type { Type } from '@nestjs/common';

export type OutboxTenantPolicy = 'optional' | 'required' | 'require-match';

export interface OutboxTenantProvider {
  getTenantId?():
    | string
    | null
    | undefined
    | Promise<string | null | undefined>;
  runWithTenant?<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
}

export interface OutboxTenancyOptions {
  provider?: Type<OutboxTenantProvider> | OutboxTenantProvider;
  /**
   * Controls producer tenant resolution. Defaults to `optional` for
   * compatibility with non-tenant applications.
   */
  policy?: OutboxTenantPolicy;
}
