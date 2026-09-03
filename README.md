# @nestarc/outbox

Prisma-native transactional outbox for NestJS — atomic event emission, polling with `FOR UPDATE SKIP LOCKED`, broker publishing, retry with backoff, metadata, admin/DLQ APIs, and `@OnOutboxEvent()` decorator.

[![npm version](https://img.shields.io/npm/v/@nestarc/outbox.svg)](https://www.npmjs.com/package/@nestarc/outbox)
[![license](https://img.shields.io/npm/l/@nestarc/outbox.svg)](https://github.com/nestarc/outbox/blob/main/LICENSE)

## Installation

```bash
npm install @nestarc/outbox @nestjs/schedule @prisma/client
```

> `@nestjs/schedule` and `@prisma/client` are peer dependencies and must be installed alongside this package.
> PostgreSQL `LISTEN/NOTIFY` wakeup support uses `pg` as an optional peer dependency. Install `pg` only when you enable `wakeup.enabled`.

### Prisma 7

`@nestarc/outbox` supports Prisma 5, 6, and 7 clients. Prisma 7 requires a driver adapter when your application constructs `PrismaClient`; for PostgreSQL, install and configure `@prisma/adapter-pg` and `pg`:

```bash
npm install @prisma/adapter-pg pg
```

```typescript
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});
export const prisma = new PrismaClient({ adapter });
```

Pass that configured client (or your Nest `PrismaService` wrapper) to `OutboxModule`. Outbox does not create or replace the application's Prisma client or connection pool.

## Quick Start

### 1. Register the module

```typescript
import { OutboxModule } from '@nestarc/outbox';

@Module({
  imports: [
    OutboxModule.forRoot({
      prisma: PrismaService,
      polling: {
        enabled: true,
        interval: 5000,
        batchSize: 100,
      },
      retry: {
        maxRetries: 5,
        backoff: 'exponential',
        initialDelay: 1000,
      },
    }),
  ],
})
export class AppModule {}
```

> When passing a class reference to `prisma` in `forRoot()`, the class must be provided by a `@Global()` module (e.g. `PrismaModule`) so NestJS can resolve it across module boundaries.

### 2. Define an event class

```typescript
import { OutboxEvent } from '@nestarc/outbox';

export class OrderCreatedEvent extends OutboxEvent {
  static readonly eventType = 'order.created';

  constructor(
    public readonly orderId: string,
    public readonly total: number,
  ) {
    super();
  }
}
```

### 3. Emit inside a transaction

```typescript
import { OutboxEmitter } from '@nestarc/outbox';

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxEmitter,
  ) {}

  async createOrder(dto: CreateOrderDto) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({ data: dto });
      await this.outbox.emit(tx, new OrderCreatedEvent(order.id, dto.total), {
        tenantId: dto.tenantId,
        aggregateType: 'Order',
        aggregateId: order.id,
        partitionKey: order.id,
        idempotencyKey: dto.requestId,
        correlationId: dto.requestId,
        headers: { source: 'orders-api' },
      });
      return order;
    });
  }
}
```

The `outbox.emit(tx, event)` call writes the event row in the **same database transaction** as your business logic. If the transaction rolls back, the event is never stored — no dual-write problem.

The third argument is optional. Use it when downstream consumers need stable metadata for broker routing, idempotency, tracing, replay, or tenant-aware operations.

### 4. Handle the event

```typescript
import { OnOutboxEvent, OutboxHandlerContext } from '@nestarc/outbox';

@Injectable()
export class OrderNotificationListener {
  @OnOutboxEvent(OrderCreatedEvent)
  async handleOrderCreated(
    payload: { orderId: string; total: number },
    context: OutboxHandlerContext,
  ) {
    // context.eventId is useful as an idempotency key.
    await this.emailService.sendOrderConfirmation(payload.orderId);
  }
}
```

> If an event type has no registered handlers, the event is marked `FAILED` with an explanatory `last_error` to prevent silent data loss. Check your handler registrations if you see unexpected `FAILED` events.

## SQL Migration

The `outbox_events` table is **not** managed through your `schema.prisma`. It uses raw SQL so there is no need to add a Prisma model to your schema.

The migration file is shipped with the package at `src/sql/create-outbox-table.sql`. Run it once against your database:

```bash
# Print the path to the bundled SQL file
node -e "console.log(require.resolve('@nestarc/outbox/src/sql/create-outbox-table.sql'))"

# Apply with psql
psql "$DATABASE_URL" -f "$(node -e "console.log(require.resolve('@nestarc/outbox/src/sql/create-outbox-table.sql'))")"
```

The file creates the table, retry/status indexes, and metadata indexes. It is safe to run multiple times (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`).

For an existing 0.1.x install, apply the additive upgrade file:

```bash
psql "$DATABASE_URL" -f "$(node -e "console.log(require.resolve('@nestarc/outbox/src/sql/upgrade-0.1-to-0.2.sql'))")"
```

Existing 0.2.x installations must also apply the idempotent claim-fencing
upgrade before running a version that uses claim tokens:

```bash
psql "$DATABASE_URL" -f "$(node -e "console.log(require.resolve('@nestarc/outbox/src/sql/upgrade-add-claim-token.sql'))")"
```

<details>
<summary>View the full SQL</summary>

```sql
CREATE TABLE IF NOT EXISTS outbox_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    VARCHAR(255) NOT NULL,
  payload       JSONB NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  retry_count   INT NOT NULL DEFAULT 0,
  max_retries   INT NOT NULL DEFAULT 5,
  last_error    TEXT,
  tenant_id     VARCHAR(255),
  aggregate_type VARCHAR(255),
  aggregate_id   VARCHAR(255),
  partition_key  VARCHAR(255),
  idempotency_key VARCHAR(255),
  correlation_id VARCHAR(255),
  causation_id   VARCHAR(255),
  headers       JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claim_token   UUID,

  CONSTRAINT chk_status CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED'))
);

-- PENDING events: polled frequently, ordered by creation time
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_events (created_at ASC)
  WHERE status = 'PENDING';

-- PROCESSING events: stuck event recovery checks updated_at
CREATE INDEX IF NOT EXISTS idx_outbox_processing
  ON outbox_events (updated_at ASC)
  WHERE status = 'PROCESSING';

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_processing_claim_token
  ON outbox_events (claim_token)
  WHERE status = 'PROCESSING';

-- FAILED events: admin/monitoring queries
CREATE INDEX IF NOT EXISTS idx_outbox_failed
  ON outbox_events (created_at DESC)
  WHERE status = 'FAILED';

CREATE INDEX IF NOT EXISTS idx_outbox_aggregate
  ON outbox_events (aggregate_type, aggregate_id, created_at ASC)
  WHERE aggregate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_tenant_pending
  ON outbox_events (tenant_id, created_at ASC)
  WHERE status = 'PENDING' AND tenant_id IS NOT NULL;
```

</details>

## Configuration

All options passed to `OutboxModule.forRoot()` or the factory returned by `OutboxModule.forRootAsync()`.

| Option | Type | Default | Description |
|---|---|---|---|
| `prisma` | class ref / instance | **required** | `PrismaService` class reference (`forRoot`, must be `@Global`) or instance (`forRootAsync`). See `PrismaLike` type for minimum interface. |
| `polling.enabled` | `boolean` | `true` | Enable or disable the polling scheduler |
| `polling.interval` | `number` | `5000` | Milliseconds between polling cycles |
| `polling.batchSize` | `number` | `100` | Maximum events processed per polling cycle |
| `retry.maxRetries` | `number` | `5` | Maximum delivery attempts before marking an event `FAILED` |
| `retry.backoff` | `'fixed' \| 'exponential'` | `'exponential'` | Backoff strategy between retries |
| `retry.initialDelay` | `number` | `1000` | Initial delay in ms (base for exponential, constant for fixed) |
| `delivery.mode` | `'local' \| 'publisher'` | `'local'` | `local` requires registered `@OnOutboxEvent()` handlers; `publisher` sends records to a broker-style transport without requiring local handlers. |
| `transport` | `Type` | `LocalTransport` | Custom transport class implementing `OutboxTransport` or `OutboxPublisher`. |
| `tenancy.provider` | `OutboxTenantProvider` / `Type` | none | Optional tenant provider. `emit()` uses explicit `tenantId` first, then `provider.getTenantId()`. `LocalTransport` restores context with `provider.runWithTenant()` when available. |
| `hooks` | `OutboxHooks` | none | Optional lifecycle callbacks for emit, poll, dispatch success/failure, retry, and dead-letter metrics/tracing. Hook failures are logged and swallowed. |
| `wakeup.enabled` | `boolean` | `false` | Enable PostgreSQL `LISTEN/NOTIFY` wakeup in addition to polling. Requires `pg` or a custom `clientFactory`. |
| `wakeup.channel` | `string` | `'outbox_events'` | PostgreSQL notification channel. |
| `wakeup.connectionString` | `string` | `pg` default | Connection string used by the notification client when `pg` is installed. |
| `isGlobal` | `boolean` | `true` | Register the module globally so `OutboxEmitter` is available everywhere |
| `stuckThreshold` | `number` | `300000` | Events stuck in `PROCESSING` longer than this (ms) are reset to `PENDING` |

### Async registration

For dynamic configuration (e.g. reading from `ConfigService`):

```typescript
OutboxModule.forRootAsync({
  imports: [PrismaModule],
  useFactory: (config: ConfigService, prisma: PrismaService) => ({
    prisma,
    polling: { interval: config.get('OUTBOX_POLL_INTERVAL') },
  }),
  inject: [ConfigService, PrismaService],
})
```

## Event Metadata

`emit()` accepts optional metadata that is stored with the event and later exposed on `OutboxRecord` and `OutboxHandlerContext`.

```typescript
await outbox.emit(tx, new OrderCreatedEvent(order.id, total), {
  tenantId: tenant.id,
  aggregateType: 'Order',
  aggregateId: order.id,
  partitionKey: order.id,
  idempotencyKey: requestId,
  correlationId: requestId,
  causationId: commandId,
  headers: { source: 'orders-api' },
  occurredAt: new Date(),
});
```

`emitMany()` accepts either plain events or per-event metadata entries:

```typescript
await outbox.emitMany(tx, [
  { event: new OrderCreatedEvent(order.id, total), options: { aggregateId: order.id } },
  { event: new OrderPaidEvent(order.id), options: { aggregateId: order.id } },
]);
```

When the Prisma transaction client exposes `$executeRawUnsafe`, `emitMany()` uses a single parameterized multi-row insert.

## Admin and DLQ API

`OutboxAdminService` is exported as a Nest provider for operational tooling.

```typescript
const failed = await admin.list({ status: 'FAILED', tenantId: 'tenant-1' });
await admin.retry(failed[0].id);

const stats = await admin.getStats();
const health = await admin.getHealth({
  maxOldestPendingAgeMs: 60_000,
  maxFailedCount: 10,
});
```

Available methods:

- `getStats()`
- `list(options?)`
- `getById(id)`
- `retry(id)`
- `retryMany(ids)`
- `markFailed(id, reason)`
- `purgeSent({ before, limit })`
- `getHealth(options?)`

`retry()` and `retryMany()` only reset `FAILED` rows to `PENDING`; they do not touch `PROCESSING` rows and do not reset `retry_count`.

## Tenancy

Tenancy integration is optional and has no hard dependency on `@nestarc/tenancy`.

```typescript
OutboxModule.forRoot({
  prisma: PrismaService,
  tenancy: {
    provider: TenantContextProvider,
  },
});
```

Tenant resolution order:

1. `emit(tx, event, { tenantId })`
2. `tenancy.provider.getTenantId()`
3. `NULL`

If `LocalTransport` receives a record with `tenantId` and the provider implements `runWithTenant()`, local handlers run inside that tenant context.

## Observability Hooks

Use hooks for metrics, traces, and delivery audit logs without adding an OpenTelemetry dependency to the package.

```typescript
OutboxModule.forRoot({
  prisma: PrismaService,
  hooks: {
    onDispatchSuccess: ({ eventType, tenantId, durationMs }) => {
      metrics.histogram('outbox.dispatch.duration', durationMs, {
        eventType,
        tenantId,
      });
    },
    onDeadLetter: ({ eventId, error }) => {
      logger.error({ eventId, error }, 'outbox event dead-lettered');
    },
  },
});
```

Hook errors are logged and swallowed so observability failures do not alter delivery state.

## PostgreSQL LISTEN/NOTIFY Wakeup

Polling remains the source of truth. Wakeup is an optional latency improvement: the emitter sends `pg_notify()` inside the same database transaction, and `OutboxListener` triggers `poll()` when PostgreSQL delivers the notification after commit.

```bash
npm install pg
```

```typescript
OutboxModule.forRoot({
  prisma: PrismaService,
  polling: { interval: 5000 },
  wakeup: {
    enabled: true,
    channel: 'outbox_events',
    connectionString: process.env.DATABASE_URL,
  },
});
```

If `wakeup.enabled` is true but `pg` is not installed, the package logs a warning and continues with normal polling fallback.

## Retry and Backoff

When a listener throws, the event `retry_count` is incremented and the event is rescheduled as `PENDING`. The failure threshold uses the per-record `max_retries` value stored in the database at emit time, so configuration changes during rolling deployments do not affect in-flight events.

**Fixed backoff** — the delay between attempts is always `initialDelay` ms.

**Exponential backoff** — the delay doubles on every attempt:

```
delay = initialDelay * 2^(retry_count - 1)
```

With the defaults (`initialDelay: 1000`, `maxRetries: 5`), the event is attempted up to 5 times. After the first failed attempt, the retry delays are:
1 s → 2 s → 4 s → 8 s → FAILED

`FAILED` events are kept in the table for observability and can be reprocessed manually by resetting their status to `PENDING`.

## Multi-Instance Safety

When multiple application instances run against the same database (horizontal scaling, rolling deployments), each polling cycle uses `SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction.

- The first instance to acquire a row locks it and processes it.
- Other instances skip locked rows and move on.
- No event is ever processed twice concurrently.
- No external coordinator (Redis, Zookeeper, etc.) is required.

## Graceful Shutdown

When the NestJS application receives a shutdown signal:

1. The polling scheduler stops accepting new cycles.
2. Any in-flight poll (including active DB queries) is allowed to complete.
3. Only then does the process exit.

This prevents an event from being left permanently in the `PROCESSING` status due to an abrupt shutdown. Events that do get stuck (e.g. a SIGKILL) are recovered automatically on the next startup via the `stuckThreshold` mechanism.

## Custom Transport

The default `delivery.mode` is `local`: the poller looks up registered `@OnOutboxEvent()` handlers and invokes them through `LocalTransport`. In local mode, an event type with no registered handlers is marked `FAILED` to prevent silent data loss.

For broker-style delivery, set `delivery.mode` to `publisher` and provide a transport that implements `OutboxPublisher`. Publisher mode does not require local handlers:

```typescript
import { OutboxPublisher, OutboxRecord } from '@nestarc/outbox';

@Injectable()
export class KafkaTransport implements OutboxPublisher {
  constructor(private readonly kafka: KafkaProducer) {}

  async publish(record: OutboxRecord): Promise<void> {
    await this.kafka.send({
      topic: record.eventType,
      messages: [
        {
          key: record.partitionKey ?? record.aggregateId ?? record.id,
          value: JSON.stringify(record.payload),
          headers: record.headers,
        },
      ],
    });
  }
}
```

Register it via module options:

```typescript
OutboxModule.forRoot({
  prisma: PrismaService,
  delivery: { mode: 'publisher' },
  transport: KafkaTransport,
})
```

Legacy custom transports that implement `dispatch(record, handlers)` can also run in publisher mode. In that case the poller calls `dispatch(record, [])`, so broker transports should not depend on local handlers.

## Ecosystem

| Package | Description |
|---|---|
| [`@nestarc/tenancy`](https://www.npmjs.com/package/@nestarc/tenancy) | Multi-tenancy for NestJS and Prisma — row-level isolation with zero boilerplate |
| [`@nestarc/idempotency`](https://www.npmjs.com/package/@nestarc/idempotency) | Idempotent request handling for NestJS — deduplicate API calls at the decorator level |

The `outbox_events` table includes `tenant_id`, aggregate metadata, idempotency keys, correlation ids, and headers so `@nestarc/tenancy`, `@nestarc/idempotency`, broker transports, and internal admin tools can share the same reliability layer.

## License

MIT — see [LICENSE](./LICENSE) for details.
