import { Inject, Injectable, Optional } from '@nestjs/common';
import { OUTBOX_TENANT_PROVIDER } from '../outbox.constants';
import type { OutboxHandlerContext } from '../interfaces/outbox-handler-context.interface';
import type { OutboxHandler } from '../interfaces/outbox-handler.interface';
import type { OutboxRecord } from '../interfaces/outbox-record.interface';
import type { OutboxTenantProvider } from '../interfaces/outbox-tenancy.interface';
import type { OutboxTransport } from '../interfaces/outbox-transport.interface';

@Injectable()
export class LocalTransport implements OutboxTransport {
  constructor(
    @Optional()
    @Inject(OUTBOX_TENANT_PROVIDER)
    private readonly tenantProvider?: OutboxTenantProvider | null,
  ) {}

  async dispatch(
    record: OutboxRecord,
    handlers: OutboxHandler[],
    context: OutboxHandlerContext = this.createContext(record),
  ): Promise<void> {
    const runHandlers = async () => {
      for (const handler of handlers) {
        const handlerRecord = structuredClone(record);
        const handlerContext: OutboxHandlerContext = {
          ...structuredClone(context),
          record: handlerRecord,
          headers: handlerRecord.headers,
        };
        await handler.instance[handler.methodName](
          handlerRecord.payload,
          handlerContext,
        );
      }
    };

    if (record.tenantId && this.tenantProvider?.runWithTenant) {
      await this.tenantProvider.runWithTenant(record.tenantId, runHandlers);
      return;
    }

    await runHandlers();
  }

  private createContext(record: OutboxRecord): OutboxHandlerContext {
    return {
      record,
      eventId: record.id,
      eventType: record.eventType,
      tenantId: record.tenantId,
      retryCount: record.retryCount,
      headers: record.headers,
    };
  }
}
