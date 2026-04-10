// Module
export { OutboxModule } from './outbox.module';

// Core
export { OutboxEvent } from './outbox.event';
export { OutboxEmitter } from './outbox.emitter';
export { OnOutboxEvent } from './outbox.decorator';

// Transport
export { LocalTransport } from './transports/local.transport';

// Constants (injection tokens)
export {
  OUTBOX_OPTIONS,
  OUTBOX_TRANSPORT,
  OUTBOX_EVENT_METADATA,
} from './outbox.constants';

// Interfaces
export type {
  OutboxOptions,
  OutboxAsyncOptions,
  OutboxOptionsFactory,
  OutboxPollingOptions,
  OutboxRetryOptions,
} from './interfaces/outbox-options.interface';
export type { OutboxRecord } from './interfaces/outbox-record.interface';
export type { OutboxTransport } from './interfaces/outbox-transport.interface';
export type { OutboxHandler } from './interfaces/outbox-handler.interface';
export type { PrismaTransactionClient } from './interfaces/prisma-transaction-client.interface';
