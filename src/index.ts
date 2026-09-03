// Module
export { OutboxModule } from './outbox.module';

// Core
export { OutboxEvent } from './outbox.event';
export { OutboxAdminService } from './outbox.admin.service';
export { OutboxEmitter } from './outbox.emitter';
export { OutboxListener } from './outbox.listener';
export { OnOutboxEvent } from './outbox.decorator';

// Transport
export { LocalTransport } from './transports/local.transport';

// Constants (injection tokens)
export {
  OUTBOX_OPTIONS,
  OUTBOX_TRANSPORT,
  OUTBOX_TENANT_PROVIDER,
  OUTBOX_EVENT_METADATA,
} from './outbox.constants';

// Interfaces
export type {
  OutboxHealth,
  OutboxHealthOptions,
  OutboxListOptions,
  OutboxAdminMutationResult,
  OutboxStats,
} from './interfaces/outbox-admin.interface';
export type {
  OutboxOptions,
  OutboxAsyncOptions,
  OutboxOptionsFactory,
  OutboxPollingOptions,
  OutboxRetryOptions,
  OutboxDeliveryOptions,
  OutboxLeaseOptions,
} from './interfaces/outbox-options.interface';
export type {
  OutboxEmitManyEntry,
  OutboxEmitOptions,
} from './interfaces/outbox-emit-options.interface';
export type {
  OutboxDispatchContext,
  OutboxEmitContext,
  OutboxHooks,
  OutboxPollContext,
  OutboxRetryContext,
} from './interfaces/outbox-hooks.interface';
export type { OutboxHandlerContext } from './interfaces/outbox-handler-context.interface';
export type { OutboxRecord } from './interfaces/outbox-record.interface';
export type {
  OutboxTenantPolicy,
  OutboxTenancyOptions,
  OutboxTenantProvider,
} from './interfaces/outbox-tenancy.interface';
export type { OutboxTransport } from './interfaces/outbox-transport.interface';
export type {
  OutboxNotification,
  OutboxNotificationClient,
  OutboxWakeupOptions,
} from './interfaces/outbox-wakeup.interface';
export type { OutboxPublisher } from './interfaces/outbox-publisher.interface';
export type { OutboxHandler } from './interfaces/outbox-handler.interface';
export type {
  PrismaTransactionClient,
  PrismaLike,
} from './interfaces/prisma-transaction-client.interface';
