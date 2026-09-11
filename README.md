# @nestarc/outbox — PostgreSQL transactional outbox for NestJS and Prisma

Store a domain event in the same PostgreSQL transaction as your business data, then deliver it to NestJS handlers or an application-owned message broker publisher. Includes retries, renewable claim leases, tenant metadata, and APIs for inspecting and retrying failed events.

[![npm version](https://img.shields.io/npm/v/@nestarc/outbox.svg)](https://www.npmjs.com/package/@nestarc/outbox)
[![license](https://img.shields.io/npm/l/@nestarc/outbox.svg)](https://github.com/nestarc/outbox/blob/main/LICENSE)

**Documentation version:** current checkout, including **unreleased changes after 0.3.0**. For the published npm 0.3.0 package, read the [v0.3.0 README](https://github.com/nestarc/outbox/blob/v0.3.0/README.md). See the [unreleased upgrade notes](#unreleased-upgrade-notes) before testing this checkout in an existing application.

## Contents

- [Installation](#installation)
- [SQL migration](#sql-migration)
- [Quick start](#quick-start)
- [Verify delivery](#verify-delivery)
- [Delivery contract](#delivery-contract-and-duplicate-handling)
- [Usage and API reference](#usage-and-api-reference)
- [AI agent usage](#ai-agent-usage)
- [Async configuration](#configuration)
- [Tenancy](#tenancy)
- [Custom transport](#custom-transport)
- [PostgreSQL wakeup](#postgresql-listennotify-wakeup)
- [Compatibility evidence](#compatibility-evidence)
- [Upgrading](#upgrading-to-030)
- [Supported package paths](#supported-package-paths)
- [Executable example checks](#executable-example-checks)

## Installation

Use an existing NestJS application with Prisma, **Node 22 or 24**, and **PostgreSQL**. Other Prisma database providers are not supported. PostgreSQL **16** is the automated test baseline; a lower supported minimum has not been verified. Match NestJS, Schedule, and Prisma versions using the [compatibility table](#compatibility-evidence).

Install with the Schedule major that matches your NestJS application; run one command:

```bash
# NestJS 10
npm install @nestarc/outbox @nestjs/schedule@4
# NestJS 11
npm install @nestarc/outbox @nestjs/schedule@5
# NestJS 12
npm install @nestarc/outbox @nestjs/schedule@12
```

These commands install the published npm release and preserve your existing Prisma client. To run the unreleased code in this checkout, use the local-tarball instructions in the [complete quick-start application](examples/quick-start/README.md).

NestJS core/common, Schedule, Prisma Client, and `reflect-metadata` are peer dependencies; NestJS core/common and `reflect-metadata` normally already exist in the application. Keep the Prisma CLI and `@prisma/client` on matching versions from major 5, 6, or 7. If Prisma is not configured yet, start from the complete quick-start application linked above.

For **Prisma 7**, also install its PostgreSQL adapter and driver:

```bash
npm install @prisma/adapter-pg@7 pg
```

Construct your application-owned Prisma client with `PrismaPg`; see [Prisma 7 setup](docs/usage.md#prisma-7-client). `pg` is also used by the optional default LISTEN/NOTIFY client. Prisma 5/6 applications using their native engine do not need `pg` for ordinary polling. Outbox uses your configured client and does not replace its connection pool.

## SQL Migration

Apply the SQL **before starting the Nest application**. The outbox table uses raw PostgreSQL SQL; do not add an `OutboxEvent` model to `schema.prisma`.

For a fresh installation, set `DATABASE_URL` to the intended database and run:

<!-- packed-example:sql-create:start -->

```bash
# Print the path to the bundled SQL file
node -e "console.log(require.resolve('@nestarc/outbox/src/sql/create-outbox-table.sql'))"

# Apply with psql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$(node -e "console.log(require.resolve('@nestarc/outbox/src/sql/create-outbox-table.sql'))")"
```

<!-- packed-example:sql-create:end -->

The shipped file creates the table, indexes, and constraints and can be reapplied to the current schema. See the [versioned fresh SQL source](https://github.com/nestarc/outbox/blob/v0.3.0/src/sql/create-outbox-table.sql).

For an existing 0.1.x/0.2.x database, use the [upgrade procedure](#upgrading-to-030) instead. Startup validates the schema and fails with `OutboxSchemaError` (`OUTBOX_SCHEMA_MISMATCH`) when required objects are missing; it never migrates your database automatically.

## Quick Start

The snippets show the application wiring. The [complete quick-start application](examples/quick-start/README.md) supplies all imports, Prisma models, service implementations, startup code, and a transaction-based consumer deduplication example.

The defaults enable polling every 5 seconds, process up to 100 events per cycle, and allow 5 delivery attempts. Configure only the values your application needs to change.

### 1. Register the module

<!-- packed-example:local:start -->

```typescript
import { OutboxModule } from '@nestarc/outbox';

@Module({
  imports: [
    PrismaModule,
    OutboxModule.forRoot({
      prisma: PrismaService,
    }),
  ],
  providers: [OrderService, OrderNotificationListener, EmailService],
})
export class AppModule {}
```

<!-- packed-example:local:end -->

> When passing a class reference to `prisma` in `forRoot()`, the class must be provided by a `@Global()` module (e.g. `PrismaModule`) so NestJS can resolve it across module boundaries.

### 2. Define an event class

<!-- packed-example:event:start -->

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

<!-- packed-example:event:end -->

### 3. Emit inside a transaction

<!-- packed-example:emit:start -->

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

<!-- packed-example:emit:end -->

`emit()` stages the event using the caller's transaction client. Pass the same `tx` used for the business write; the business row and event then commit or roll back together.

The third argument is optional. Use it when downstream consumers need stable metadata for broker routing, idempotency, tracing, replay, or tenant-aware operations.

### 4. Handle the event

<!-- packed-example:handler:start -->

```typescript
import { OnOutboxEvent, OutboxHandlerContext } from '@nestarc/outbox';

@Injectable()
export class OrderNotificationListener {
  constructor(private readonly emailService: EmailService) {}

  @OnOutboxEvent(OrderCreatedEvent)
  async handleOrderCreated(
    payload: { orderId: string; total: number },
    context: OutboxHandlerContext,
  ) {
    await this.emailService.sendOrderConfirmation(payload.orderId, {
      idempotencyKey: context.eventId,
    });
  }
}
```

<!-- packed-example:handler:end -->

Your application-owned `EmailService` and email provider must durably enforce this idempotency key. Passing the key alone does not make Outbox deduplicate email delivery; the provider must make repeated attempts safe.

> If an event type has no registered handlers, the event is marked `FAILED` with an explanatory `last_error` to prevent silent data loss. Check your handler registrations if you see unexpected `FAILED` events.

## Verify delivery

After creating an order, wait for a polling cycle and inspect the newest events:

```sql
SELECT id, event_type, status, retry_count, last_error
FROM outbox_events
ORDER BY created_at DESC, id DESC
LIMIT 10;
```

A successful local delivery changes the row from `PENDING` through `PROCESSING` to `SENT`. The confirmation handler should have run. A rolled-back order transaction must leave no outbox row. `FAILED` with a missing-handler error means the listener provider was not registered.

Enable shutdown handling in your application bootstrap:

```typescript
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(3000);
```

The complete example includes these imports and bootstrap. The poller allows up to a fixed 30 seconds to drain; this does not forcibly cancel callbacks or external side effects. See [shutdown behavior](docs/usage.md#graceful-shutdown).

## Delivery Contract and Duplicate Handling

Polling is the durable source of truth for both delivery modes. Local handlers and
publisher callbacks are delivery attempts inside that polling loop, so all three
paths have **at-least-once** semantics.

| Contract                  | Meaning                                                                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transactional persistence | When `emit()` uses the same transaction as the business write, both commit or both roll back.                                                                                           |
| Claim isolation           | `SKIP LOCKED`, claim tokens, and renewable leases prevent a healthy active claim from being completed by another poller. They do not make external side effects exactly once.           |
| Local `SENT`              | Every registered local handler returned successfully and the fenced `SENT` update was stored. An earlier handler may already have produced a side effect before a later handler failed. |
| Publisher `SENT`          | The publisher callback resolved and the fenced `SENT` update was stored. It does not mean that a downstream broker consumer or Jobs handler completed.                                  |
| `idempotency_key`         | Application metadata carried with the record. The package does not enforce uniqueness or deduplicate producers or consumers with it.                                                    |
| `partition_key`           | Routing metadata for a custom publisher. It does not serialize claims or provide partition, aggregate, or global FIFO.                                                                  |
| Ordering                  | Strict global, aggregate, and partition FIFO are not guaranteed. Retries, multiple pollers, and callback duration can change observation order.                                         |

A callback can succeed before the process stops without recording `SENT`; retries then repeat its effects. Multiple local handlers also restart from the first handler after a later handler fails. Use a durable consumer key, normally `context.eventId`/`record.id`, and couple deduplication with the consumer side effect atomically. See [duplicate windows and the consumer contract](docs/usage.md#delivery-contract-and-duplicate-handling).

## Usage and API reference

| Task                                                     | Reference                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| Configure polling, retries, leases, hooks, and providers | [Configuration options](docs/usage.md#configuration)         |
| Emit metadata or batches                                 | [Event metadata and bulk emit](docs/usage.md#event-metadata) |
| Inspect failures, page through events, retry, or purge   | [Admin and DLQ API](docs/usage.md#admin-and-dlq-api)         |
| Select tenant attribution rules                          | [Tenant policies](docs/usage.md#tenant-policies)             |
| Interpret hooks and transaction timing                   | [Observability hooks](docs/usage.md#observability-hooks)     |
| Operate retries, reconnect, leases, and shutdown         | [Usage and operational reference](docs/usage.md)             |
| Run complete application code                            | [Quick-start project](examples/quick-start/README.md)        |

The reference belongs to this checkout and is included in the package. Prefer the documentation shipped with the installed version over historical design plans.

## AI agent usage

Start with the packaged [llms.txt](llms.txt) for the documentation reading order, then use the [complete quick-start project](examples/quick-start/README.md) and [API reference](docs/usage.md). Check the installed package version before copying an API or migration command: this checkout includes unreleased changes, while the published 0.3.0 contract has its own versioned README.

The quick-start project supplies real imports and application services. The packed example tests check the README fragments against an installed artifact; historical plans and reports are background records, not instructions for package consumers.

## Configuration

Use runtime values in `forRoot()` or the async factory. With `forRootAsync()`, register `transport`, `tenantProvider`, and `isGlobal` at the top level. The [full option reference](docs/usage.md#configuration) separates these paths.

### Async registration

For dynamic configuration (e.g. reading from `ConfigService`), this publisher
example imports modules that export `PrismaService`, `ConfigService`,
`TenantContext`, and `KafkaProducer`, respectively. `RequestTenantProvider` is
defined in [Tenancy](#tenancy); `KafkaTransport` is defined in
[Custom Transport](#custom-transport):

<!-- packed-example:async:start -->

```typescript
OutboxModule.forRootAsync({
  imports: [PrismaModule, ConfigModule, TenantContextModule, KafkaModule],
  useFactory: (config: ConfigService, prisma: PrismaService) => ({
    prisma,
    polling: { interval: config.get('OUTBOX_POLL_INTERVAL') },
    delivery: { mode: 'publisher' },
    tenancy: { policy: 'required' },
  }),
  inject: [ConfigService, PrismaService],
  tenantProvider: RequestTenantProvider,
  transport: KafkaTransport,
  isGlobal: true,
});
```

<!-- packed-example:async:end -->

`useFactory` and `OutboxOptionsFactory` own runtime values only. Provider graph
registrations (`transport`, `tenantProvider`) and module scope (`isGlobal`) are
top-level `forRootAsync` options; returning any of them from the factory is
rejected during module compilation instead of being silently ignored. Nest
constructs top-level provider classes, so their constructor dependencies must
be exported by one of the modules listed in `imports`. Passing an already
created tenant provider value is also supported.

## Tenancy

Tenancy integration is optional and has no hard dependency on `@nestarc/tenancy`.

A provider can restore trusted ambient context with `AsyncLocalStorage`. Your
request/authentication layer enters the validated tenant context; local delivery
uses `runWithTenant()` to restore the persisted tenant around each handler:

<!-- packed-example:tenant-provider:start -->

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { OutboxTenantProvider } from '@nestarc/outbox';

@Injectable()
export class TenantContext {
  readonly storage = new AsyncLocalStorage<string>();
}

@Injectable()
export class RequestTenantProvider implements OutboxTenantProvider {
  constructor(private readonly context: TenantContext) {}

  getTenantId(): string | undefined {
    return this.context.storage.getStore();
  }

  runWithTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.context.storage.run(tenantId, fn);
  }
}

export { RequestTenantProvider as TenantContextProvider };
```

<!-- packed-example:tenant-provider:end -->

Export `TenantContext` from `TenantContextModule` and include that module in
`forRootAsync.imports`. With synchronous `forRoot` below, both the Prisma
service and injected `TenantContext` must instead be exported by global modules
imported by the application:

<!-- packed-example:tenant:start -->

```typescript
OutboxModule.forRoot({
  prisma: PrismaService,
  tenancy: {
    provider: TenantContextProvider,
    policy: 'require-match',
  },
});
```

<!-- packed-example:tenant:end -->

Choose `optional`, `required`, or `require-match` explicitly for your application. `tenantId: null` is rejected; an omitted/undefined tenant falls back to the provider. Use `tenantScope: 'global'` for intentional global events. See [tenant policy behavior](docs/usage.md#tenant-policies).

## Custom Transport

The default `delivery.mode` is `local`: the poller looks up registered `@OnOutboxEvent()` handlers and invokes them through `LocalTransport`. In local mode, an event type with no registered handlers is marked `FAILED` to prevent silent data loss.

For broker-style delivery, set `delivery.mode` to `publisher` and provide a transport that implements `OutboxPublisher`. Publisher mode does not require local handlers:

<!-- packed-example:publisher:start -->

```typescript
import { OutboxPublisher, OutboxRecord } from '@nestarc/outbox';

@Injectable()
export class KafkaTransport implements OutboxPublisher {
  constructor(private readonly kafka: KafkaProducer) {}

  async publish(record: OutboxRecord): Promise<void> {
    const headers = Object.fromEntries(
      Object.entries(record.headers).filter(
        ([key]) => !key.toLowerCase().startsWith('outbox-'),
      ),
    );

    await this.kafka.send({
      topic: record.eventType,
      messages: [
        {
          key: record.partitionKey ?? record.aggregateId ?? record.id,
          value: JSON.stringify(record.payload),
          headers: {
            ...headers,
            'outbox-event-id': record.id,
            'outbox-event-type': record.eventType,
            'outbox-occurred-at': record.occurredAt.toISOString(),
            ...(record.tenantId === null
              ? {}
              : { 'outbox-tenant-id': record.tenantId }),
            ...(record.aggregateType === null
              ? {}
              : { 'outbox-aggregate-type': record.aggregateType }),
            ...(record.aggregateId === null
              ? {}
              : { 'outbox-aggregate-id': record.aggregateId }),
            ...(record.partitionKey === null
              ? {}
              : { 'outbox-partition-key': record.partitionKey }),
            ...(record.correlationId === null
              ? {}
              : { 'outbox-correlation-id': record.correlationId }),
            ...(record.causationId === null
              ? {}
              : { 'outbox-causation-id': record.causationId }),
            ...(record.idempotencyKey === null
              ? {}
              : { 'outbox-idempotency-key': record.idempotencyKey }),
          },
        },
      ],
    });
  }
}
```

<!-- packed-example:publisher:end -->

The `outbox-*` header names are an application convention in this example. They preserve the durable event identity, tenant, and tracing/deduplication metadata. Custom headers in this reserved namespace are dropped regardless of case; canonical null fields stay absent. Downstream consumers still own authorization and durable deduplication.

Here `KafkaProducer` is an application-owned adapter. Register and export it
from `KafkaModule`; the [async registration](#async-registration) example makes
that dependency visible to `KafkaTransport`. The packed example test uses a
recording producer double, so it verifies DI and message mapping, not a real
Kafka connection or broker delivery guarantees.

For synchronous registration below, `KafkaProducer` and `PrismaService` must be
exported by global modules imported by the application (`transport` stays
top-level when using `forRootAsync`):

```typescript
OutboxModule.forRoot({
  prisma: PrismaService,
  delivery: { mode: 'publisher' },
  transport: KafkaTransport,
});
```

Legacy custom transports that implement `dispatch(record, handlers)` can also run in publisher mode. In that case the poller calls `dispatch(record, [])`, so broker transports should not depend on local handlers.

## PostgreSQL LISTEN/NOTIFY Wakeup

Periodic polling remains required. PostgreSQL LISTEN/NOTIFY optionally reduces latency: `pg_notify()` runs in the event transaction, and a notification after commit triggers the same polling loop. It does not replace durable retry or lease recovery.

Install `pg` if your application does not already use it, then configure:

<!-- packed-example:wakeup:start -->

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

<!-- packed-example:wakeup:end -->

Connection or LISTEN failures degrade to periodic polling while reconnection retries in the background. `polling.enabled: false` is rejected with `OutboxConfigurationError` (`OUTBOX_INVALID_CONFIGURATION`), even with wakeup enabled. See [wakeup lifecycle and reconnect](docs/usage.md#wakeup-and-reconnect).

## Compatibility evidence

Node 22 is the minimum supported runtime. Node 22 and 24 are required controls;
Node 20 reached upstream EOL and is not supported by 0.3.0.
The following exact tuples are checked as packed packages and source tests. They are regression controls for the declared peer ranges, not proof of every possible version combination:

| Node  | NestJS  | Schedule | Prisma | Automated evidence                                                                 |
| ----- | ------- | -------- | ------ | ---------------------------------------------------------------------------------- |
| 22    | 10.4.22 | 4.1.2    | 5.22.0 | generate, strict typecheck/build, SQL asset load, PostgreSQL emit/poll/admin smoke |
| 22    | 10.4.22 | 4.1.2    | 6.19.3 | source E2E plus the same strict legacy packed PostgreSQL consumer                  |
| 22/24 | 11.2.3  | 5.0.1    | 7.10.0 | source E2E; Node 22 also runs the strict packed PostgreSQL consumer                |
| 22/24 | 12.0.1  | 12.0.1   | 7.10.0 | source E2E plus strict packed PostgreSQL consumer on both required Node controls   |

All three Prisma majors consume the same package root declarations and shipped
`src/sql` assets. Node 26 is pre-LTS and runs only as an allowed-failure canary;
passing that canary does not make it supported. Compatibility outside the
declared peer ranges is not implied.

## Upgrading to 0.3.0

0.3.0 is a pre-1.0 minor release with required schema and public API changes.
Before deployment:

1. Move to Node 22 or 24 and a supported NestJS/Schedule/Prisma tuple from the
   [compatibility table](#compatibility-evidence).
2. Stop and drain every old poller, then apply the bundled
   [unified SQL upgrade](#upgrading-to-030) using the 0.3.0 package. Schedule a
   maintenance window for index and constraint changes; repair any invalid
   existing rows reported by the migration before starting new pollers.
   Do not run 0.2.x pollers alongside 0.3.0: old workers do not honor claim
   tokens, leases, or persisted retry due times.
3. Import runtime values and types from `@nestarc/outbox`. Replace deep imports
   into `dist/**` or individual migration files with the root or the two
   [supported SQL paths](#supported-package-paths).
4. For `forRootAsync()`, move factory-returned `transport`, `tenancy.provider`,
   and `isGlobal` registrations to top-level `transport`, `tenantProvider`,
   and `isGlobal`. Import the modules that export their injected dependencies;
   keep runtime settings such as `tenancy.policy` inside the factory result.
5. Replace `tenantId: null` with `tenantScope: 'global'` for intentional global
   events. An undefined tenant now falls back to the provider. Choose
   `tenancy.policy` explicitly when tenant attribution is required.
6. Update `retry()` and `markFailed()` callers to inspect the returned
   `OutboxAdminMutationResult.outcome` instead of treating the result as a
   boolean. Handle `applied`, `not_found`, `conflict`, and `lost_claim`;
   `markFailed()` now accepts only `PENDING` and cannot cancel active delivery.
   Use `OutboxOperatorService` only in privileged code, or a fixed tenant scope
   from `OutboxTenantAdminService` for tenant-facing operations.
7. Treat records and callback/hook contexts as readonly detached snapshots.
   Review producer JSON/envelope and runtime option validation: invalid input
   now fails before SQL or startup instead of reaching delivery callbacks.

Retry eligibility is persisted in `next_attempt_at`; different worker backoff
settings no longer reschedule already-failed rows. `stuckThreshold` remains a
deprecated alias for `lease.duration`. Delivery remains **at-least-once**:
consumers must be idempotent, and neither FIFO nor downstream completion is
implied by `SENT`. Hooks remain best-effort observations, including `onEmit`
before the caller's transaction commits.

After draining old pollers, apply the shipped upgrade:

<!-- packed-example:sql-upgrade:start -->

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$(node -e "console.log(require.resolve('@nestarc/outbox/src/sql/upgrade-to-current.sql'))")"
```

<!-- packed-example:sql-upgrade:end -->

The upgrade validates existing rows and may acquire locks for index replacement and constraints. Repair invalid rows before retrying it and plan a maintenance window for large tables. See [schema diagnostics and upgrade details](docs/usage.md#schema-diagnostics-and-upgrades) and the [versioned SQL source](https://github.com/nestarc/outbox/blob/v0.3.0/src/sql/upgrade-to-current.sql).

## Unreleased upgrade notes

These changes are in the current checkout and have **not** been published as a new npm release:

- Keep periodic polling enabled. The previous notification-only configuration (`polling.enabled: false`) is now rejected at module initialization with `OutboxConfigurationError`. Notifications remain an optional latency improvement.
- Discard previously saved `listPage()` v1 cursors and restart from the first page. Cursor v2 preserves PostgreSQL timestamp microseconds; v1 input returns `OUTBOX_INVALID_CURSOR`.
- Correct invalid hook, tenant-provider, and notification settings before startup; the current checkout validates their object and callback shapes explicitly.

The package version remains 0.3.0 until a release is prepared. Test these changes using the local package artifact rather than assuming an unversioned npm install includes them.

## Supported package paths

Import runtime values and types from `@nestarc/outbox`. The supported SQL subpaths are:

- `@nestarc/outbox/src/sql/create-outbox-table.sql`
- `@nestarc/outbox/src/sql/upgrade-to-current.sql`

Resolve the fresh SQL for a new database and the unified upgrade for a supported existing schema. Compiled `dist/**` internals and component/historical SQL files are not public imports. Package-local Markdown guides are documentation assets, not JavaScript import subpaths.

## Executable example checks

The marked TypeScript examples in this README are extracted from the **installed tarball README** by `npm run test:packed-examples`. A strict isolated consumer compiles them with `skipLibCheck: false`, initializes the real Nest module graph, and exercises transactions and delivery against PostgreSQL 16 with and without optional `pg`.

The fixture supplies application-owned Prisma models, imports, configuration, and email/broker doubles. SQL shell fragments are checked for their package paths and the resolved SQL is executed with Prisma CLI; the literal `psql` commands are not executed by this fixture. Broker/email doubles do not prove external delivery guarantees.

See [the fixture and run instructions](https://github.com/nestarc/outbox/blob/main/test/packed-examples/README.md) and the [complete quick-start application](examples/quick-start/README.md).

## Ecosystem

Related packages can be integrated through your application's tenant provider and consumer logic:

- [`@nestarc/tenancy`](https://www.npmjs.com/package/@nestarc/tenancy) — tenant context and isolation tools for NestJS/Prisma applications.
- [`@nestarc/idempotency`](https://www.npmjs.com/package/@nestarc/idempotency) — request idempotency tools for NestJS applications.

Outbox does not automatically wire these packages or provide durable consumer deduplication through metadata alone.

## License

MIT — see [LICENSE](./LICENSE) for details.
