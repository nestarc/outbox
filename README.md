# @nestarc/outbox

Prisma-native transactional outbox for NestJS — atomic event emission, polling with `FOR UPDATE SKIP LOCKED`, retry with backoff, and `@OnOutboxEvent()` decorator.

[![npm version](https://img.shields.io/npm/v/@nestarc/outbox.svg)](https://www.npmjs.com/package/@nestarc/outbox)
[![license](https://img.shields.io/npm/l/@nestarc/outbox.svg)](https://github.com/nestarc/outbox/blob/main/LICENSE)

## Installation

```bash
npm install @nestarc/outbox @nestjs/schedule @prisma/client
```

> `@nestjs/schedule` and `@prisma/client` are peer dependencies and must be installed alongside this package.

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
      await this.outbox.emit(tx, new OrderCreatedEvent(order.id, dto.total));
      return order;
    });
  }
}
```

The `outbox.emit(tx, event)` call writes the event row in the **same database transaction** as your business logic. If the transaction rolls back, the event is never stored — no dual-write problem.

### 4. Handle the event

```typescript
import { OnOutboxEvent } from '@nestarc/outbox';

@Injectable()
export class OrderNotificationListener {
  @OnOutboxEvent(OrderCreatedEvent)
  async handleOrderCreated(payload: { orderId: string; total: number }) {
    await this.emailService.sendOrderConfirmation(payload.orderId);
  }
}
```

## SQL Migration

The `outbox_events` table is **not** managed through your `schema.prisma`. It uses raw SQL so there is no need to add a Prisma model to your schema.

The migration file is shipped with the package at `src/sql/create-outbox-table.sql`. Run it once against your database:

```bash
# Print the path to the bundled SQL file
node -e "console.log(require.resolve('@nestarc/outbox/src/sql/create-outbox-table.sql'))"

# Apply with psql
psql "$DATABASE_URL" -f "$(node -e "console.log(require.resolve('@nestarc/outbox/src/sql/create-outbox-table.sql'))")"
```

The file creates the table and three partial indexes (PENDING, PROCESSING, FAILED) and is safe to run multiple times (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`).

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

-- FAILED events: admin/monitoring queries
CREATE INDEX IF NOT EXISTS idx_outbox_failed
  ON outbox_events (created_at DESC)
  WHERE status = 'FAILED';
```

</details>

## Configuration

All options passed to `OutboxModule.forRoot()` or the factory returned by `OutboxModule.forRootAsync()`.

| Option | Type | Default | Description |
|---|---|---|---|
| `prisma` | `Type<any>` / instance | **required** | `PrismaService` class reference (`forRoot`) or instance (`forRootAsync`) |
| `polling.enabled` | `boolean` | `true` | Enable or disable the polling scheduler |
| `polling.interval` | `number` | `5000` | Milliseconds between polling cycles |
| `polling.batchSize` | `number` | `100` | Maximum events processed per polling cycle |
| `retry.maxRetries` | `number` | `5` | Maximum delivery attempts before marking an event `FAILED` |
| `retry.backoff` | `'fixed' \| 'exponential'` | `'exponential'` | Backoff strategy between retries |
| `retry.initialDelay` | `number` | `1000` | Initial delay in ms (base for exponential, constant for fixed) |
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

## Retry and Backoff

When a listener throws, the event `retry_count` is incremented and the event is rescheduled. Processing stops once `retry_count` reaches `max_retries`, at which point the status is set to `FAILED`.

**Fixed backoff** — the delay between attempts is always `initialDelay` ms.

**Exponential backoff** — the delay doubles on every attempt:

```
delay = initialDelay * 2^(retry_count)
```

With the defaults (`initialDelay: 1000`, `maxRetries: 5`) the schedule is:
1 s → 2 s → 4 s → 8 s → 16 s → FAILED

`FAILED` events are kept in the table for observability and can be reprocessed manually by resetting their status to `PENDING`.

## Multi-Instance Safety

When multiple application instances run against the same database (horizontal scaling, rolling deployments), each polling cycle uses `SELECT … FOR UPDATE SKIP LOCKED` inside a transaction.

- The first instance to acquire a row locks it and processes it.
- Other instances skip locked rows and move on.
- No event is ever processed twice concurrently.
- No external coordinator (Redis, Zookeeper, etc.) is required.

## Graceful Shutdown

When the NestJS application receives a shutdown signal:

1. The polling scheduler stops accepting new cycles.
2. Any cycle currently in flight is allowed to complete.
3. Only then does the process exit.

This prevents an event from being left permanently in the `PROCESSING` status due to an abrupt shutdown. Events that do get stuck (e.g. a SIGKILL) are recovered automatically on the next startup via the `stuckThreshold` mechanism.

## Custom Transport (v0.2)

`OutboxTransport` is the extension point for future versions. Today the built-in `LocalTransport` dispatches events directly to in-process `@OnOutboxEvent()` listeners.

In v0.2, you will be able to implement the `OutboxTransport` interface to deliver events to external brokers:

```typescript
import { OutboxTransport, OutboxRecord, OutboxHandler } from '@nestarc/outbox';

@Injectable()
export class KafkaTransport implements OutboxTransport {
  async dispatch(record: OutboxRecord, handlers: OutboxHandler[]): Promise<void> {
    await this.kafkaProducer.send({
      topic: record.eventType,
      messages: [{ value: JSON.stringify(record.payload) }],
    });
  }
}
```

> Custom transport registration via module options is not yet available in v0.1. The `OutboxTransport` interface is exported for early adopters who want to prepare their implementations.

## Ecosystem

| Package | Description |
|---|---|
| [`@nestarc/tenancy`](https://www.npmjs.com/package/@nestarc/tenancy) | Multi-tenancy for NestJS and Prisma — row-level isolation with zero boilerplate |
| [`@nestarc/idempotency`](https://www.npmjs.com/package/@nestarc/idempotency) | Idempotent request handling for NestJS — deduplicate API calls at the decorator level |

The `outbox_events` table includes a `tenant_id` column for future `@nestarc/tenancy` integration. In v0.2, this will be populated automatically when the tenancy context is active. Currently, it defaults to `NULL`.

## License

MIT — see [LICENSE](./LICENSE) for details.
