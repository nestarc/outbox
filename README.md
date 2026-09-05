# @nestarc/outbox

Prisma-native transactional outbox for NestJS — atomic event emission, polling with `FOR UPDATE SKIP LOCKED`, broker publishing, retry with backoff, metadata, admin/DLQ APIs, and `@OnOutboxEvent()` decorator.

[![npm version](https://img.shields.io/npm/v/@nestarc/outbox.svg)](https://www.npmjs.com/package/@nestarc/outbox)
[![license](https://img.shields.io/npm/l/@nestarc/outbox.svg)](https://github.com/nestarc/outbox/blob/main/LICENSE)

## Installation

This checkout targets **0.3.0**. Existing 0.1.x/0.2.x applications must complete
the [0.3.0 upgrade steps](#upgrading-to-030) before starting the new runtime.

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

### Compatibility evidence

Node 22 is the minimum supported runtime. Node 22 and 24 are required controls;
Node 20 reached upstream EOL and is not supported by 0.3.0.
The declared framework and Prisma ranges are exercised as packed packages, not
only against the repository's development dependencies:

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

## Quick Start

### 1. Register the module

<!-- packed-example:local:start -->
```typescript
import { OutboxModule } from '@nestarc/outbox';

@Module({
  imports: [
    PrismaModule,
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

The `outbox.emit(tx, event)` call writes the event row in the **same database transaction** as your business logic. If the transaction rolls back, the event is never stored — no dual-write problem.

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
    // context.eventId is useful as an idempotency key.
    await this.emailService.sendOrderConfirmation(payload.orderId);
  }
}
```
<!-- packed-example:handler:end -->

> If an event type has no registered handlers, the event is marked `FAILED` with an explanatory `last_error` to prevent silent data loss. Check your handler registrations if you see unexpected `FAILED` events.

### Executable example checks

The marked examples above and the async, tenant-provider, publisher, wakeup,
and SQL examples below are extracted from the **installed tarball README** by
`npm run test:packed-examples`. A strict isolated consumer compiles them with
`skipLibCheck: false`, initializes the real Nest module graph, and exercises
transactions and delivery against PostgreSQL 16 with and without optional `pg`.
The fixture supplies application-owned Prisma models, imports, configuration,
and email/broker doubles; register your own services in those places.

See [the fixture and run instructions](test/packed-examples/README.md).

## Upgrading to 0.3.0

0.3.0 is a pre-1.0 minor release with required schema and public API changes.
Before deployment:

1. Move to Node 22 or 24 and a supported NestJS/Schedule/Prisma tuple from the
   compatibility table above.
2. Stop and drain every old poller, then apply the bundled
   [unified SQL upgrade](#sql-migration) using the 0.3.0 package. Schedule a
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

## SQL Migration

The `outbox_events` table is **not** managed through your `schema.prisma`. It uses raw SQL so there is no need to add a Prisma model to your schema.

The migration file is shipped with the package at `src/sql/create-outbox-table.sql`. Run it once against your database:

<!-- packed-example:sql-create:start -->
```bash
# Print the path to the bundled SQL file
node -e "console.log(require.resolve('@nestarc/outbox/src/sql/create-outbox-table.sql'))"

# Apply with psql
psql "$DATABASE_URL" -f "$(node -e "console.log(require.resolve('@nestarc/outbox/src/sql/create-outbox-table.sql'))")"
```
<!-- packed-example:sql-create:end -->

The file creates the table, retry/status indexes, and metadata indexes. It is safe to run multiple times (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`).

For every existing 0.1.x or 0.2.x install, stop/drain old pollers and apply the
single idempotent current upgrade before starting this runtime:

<!-- packed-example:sql-upgrade:start -->
```bash
psql "$DATABASE_URL" -f "$(node -e "console.log(require.resolve('@nestarc/outbox/src/sql/upgrade-to-current.sql'))")"
```
<!-- packed-example:sql-upgrade:end -->

The unified upgrade adds v0.2 metadata plus claim ownership, lease, persisted
retry scheduling, admin cursor/retention indexes, and current CHECK
constraints. It validates existing rows and fails if it finds a negative
retry count, a non-positive retry limit, a non-object payload/headers value, or
claim metadata attached to a non-`PROCESSING` row. Repair or quarantine those
rows explicitly before retrying the migration; the runtime will not dispatch
them silently. Index replacement and CHECK validation can acquire locks, so
schedule a maintenance window for large tables.

At Nest initialization the package inventories the table, columns, required
indexes, and constraints. An old or incomplete database fails before polling
with `OutboxSchemaError` (`OUTBOX_SCHEMA_MISMATCH`), including
`requiredVersion`, the detected `actualVersion`, and missing objects. This is a
diagnostic check, not an automatic migration; apply the shipped SQL explicitly.

### Supported package paths

The public package surface is the `@nestarc/outbox` root plus the two SQL paths
shown above. Compiled internals and component/historical migration files are
not public imports, even when they remain in the tarball for release evidence.
Use the root entrypoint for runtime values and types, the create SQL for a fresh
database, and `upgrade-to-current.sql` for every supported existing schema.

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
  next_attempt_at TIMESTAMPTZ,
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
  lease_expires_at TIMESTAMPTZ,

  CONSTRAINT chk_status CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED')),
  CONSTRAINT chk_retry_count_nonnegative CHECK (retry_count >= 0),
  CONSTRAINT chk_max_retries_positive CHECK (max_retries > 0),
  CONSTRAINT chk_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT chk_headers_object CHECK (jsonb_typeof(headers) = 'object'),
  CONSTRAINT chk_nonprocessing_claim_clear CHECK (
    status = 'PROCESSING'
    OR (claim_token IS NULL AND lease_expires_at IS NULL)
  )
);

-- PENDING eligibility lookup; this is not a FIFO guarantee
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_events (next_attempt_at ASC NULLS FIRST, created_at ASC)
  WHERE status = 'PENDING';

-- PROCESSING events: stuck event recovery checks updated_at
CREATE INDEX IF NOT EXISTS idx_outbox_processing
  ON outbox_events (updated_at ASC)
  WHERE status = 'PROCESSING';

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_processing_claim_token
  ON outbox_events (claim_token)
  WHERE status = 'PROCESSING';

CREATE INDEX IF NOT EXISTS idx_outbox_processing_lease_expiry
  ON outbox_events (lease_expires_at ASC)
  WHERE status = 'PROCESSING';

-- FAILED events: admin/monitoring queries
CREATE INDEX IF NOT EXISTS idx_outbox_failed
  ON outbox_events (created_at DESC, id DESC)
  WHERE status = 'FAILED';

CREATE INDEX IF NOT EXISTS idx_outbox_admin_created
  ON outbox_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_outbox_tenant_admin
  ON outbox_events (tenant_id, created_at DESC, id DESC)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_tenant_status_admin
  ON outbox_events (tenant_id, status, created_at DESC, id DESC)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_tenant_processing
  ON outbox_events (tenant_id, updated_at ASC)
  WHERE status = 'PROCESSING' AND tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_sent_retention
  ON outbox_events (processed_at ASC, id ASC)
  WHERE status = 'SENT';

CREATE INDEX IF NOT EXISTS idx_outbox_tenant_sent_retention
  ON outbox_events (tenant_id, processed_at ASC, id ASC)
  WHERE status = 'SENT' AND tenant_id IS NOT NULL;

-- Aggregate lookup/replay support only; this is not a FIFO constraint
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

| Option                            | Type                                    | Default                      | Description                                                                                                                                                                          |
| --------------------------------- | --------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prisma`                          | class ref / instance                    | **required**                 | `PrismaService` class reference (`forRoot`, must be `@Global`) or instance (`forRootAsync`). See `PrismaLike` type for minimum interface.                                            |
| `polling.enabled`                 | `boolean`                               | `true`                       | Enable or disable the polling scheduler                                                                                                                                              |
| `polling.interval`                | `number`                                | `5000`                       | Milliseconds between polling cycles; safe integer from 1 through `2147483647`                                                                                                        |
| `polling.batchSize`               | `number`                                | `100`                        | Maximum events processed per polling cycle; safe integer from 1 through `10000`                                                                                                      |
| `retry.maxRetries`                | `number`                                | `5`                          | Maximum delivery attempts before marking an event `FAILED`; positive PostgreSQL `INT` range                                                                                          |
| `retry.backoff`                   | `'fixed' \| 'exponential'`              | `'exponential'`              | Backoff strategy between retries                                                                                                                                                     |
| `retry.initialDelay`              | `number`                                | `1000`                       | Initial delay in ms (base for exponential, constant for fixed); non-negative safe integer no greater than `retry.maxDelay`                                                           |
| `retry.maxDelay`                  | `number`                                | `86400000`                   | Maximum persisted retry delay in ms. Must be no greater than `2147483647`; exponential delays saturate at this value.                                                                |
| `delivery.mode`                   | `'local' \| 'publisher'`                | `'local'`                    | `local` requires registered `@OnOutboxEvent()` handlers; `publisher` sends records to a broker-style transport without requiring local handlers.                                     |
| `transport`                       | `Type`                                  | `LocalTransport`             | Custom transport class implementing `OutboxTransport` or `OutboxPublisher`. For `forRootAsync`, register this as a top-level option so Nest can inject its constructor dependencies. |
| `tenancy.provider`                | `OutboxTenantProvider` / `Type`         | none                         | Optional trusted tenant provider for `forRoot`. `LocalTransport` restores context with `provider.runWithTenant()` when available.                                                    |
| `tenantProvider`                  | `OutboxTenantProvider` / `Type`         | none                         | `forRootAsync` top-level tenant provider registration. Provider classes are constructed by Nest and may inject dependencies from `imports`.                                          |
| `tenancy.policy`                  | `optional \| required \| require-match` | `optional`                   | Producer provenance policy. `required` rejects a missing tenant; `require-match` also compares an explicit tenant with the provider exactly.                                         |
| `hooks`                           | `OutboxHooks`                           | none                         | Optional lifecycle callbacks for emit, poll, dispatch success/failure, retry, and dead-letter metrics/tracing. Hook failures are logged and swallowed.                               |
| `wakeup.enabled`                  | `boolean`                               | `false`                      | Enable PostgreSQL `LISTEN/NOTIFY` wakeup in addition to polling. Requires `pg` or a custom `clientFactory`.                                                                          |
| `wakeup.channel`                  | `string`                                | `'outbox_events'`            | PostgreSQL notification channel.                                                                                                                                                     |
| `wakeup.connectionString`         | `string`                                | `pg` default                 | Connection string used by the notification client when `pg` is installed.                                                                                                            |
| `wakeup.reconnectDelay`           | `number`                                | `5000`                       | Positive safe-integer base reconnect delay in ms. Consecutive failures back off exponentially up to 60 seconds and reset after a successful `LISTEN`.                                |
| `lease.duration`                  | `number`                                | `stuckThreshold` or `300000` | Positive safe-integer claim lifetime in ms. Active callbacks renew the lease; expired claims are eligible for recovery.                                                              |
| `lease.heartbeatInterval`         | `number`                                | `lease.duration / 3`         | Heartbeat interval in ms. Must be positive and less than half of `lease.duration`.                                                                                                   |
| `lease.heartbeatFailureTolerance` | `number`                                | `1`                          | Non-negative integer count of heartbeat errors tolerated before the claimant abandons completion and lets the lease expire.                                                          |
| `isGlobal`                        | `boolean`                               | `true`                       | Register the module globally so `OutboxEmitter` is available everywhere                                                                                                              |
| `stuckThreshold`                  | `number`                                | `300000`                     | Deprecated positive safe-integer compatibility alias for `lease.duration`; ignored when `lease.duration` is set.                                                                     |

Both synchronous and async registration paths validate these values before the
module can start. Invalid configuration throws `OutboxConfigurationError` with
code `OUTBOX_INVALID_CONFIGURATION`. Polling disabled without an available
wakeup path fails module initialization with `OutboxWakeupUnavailableError`.
Rows read by the poller and admin APIs are also checked before exposure or
delivery; corrupt status, retry, date, payload, or headers values throw
`OutboxPersistedInvariantError` with code
`OUTBOX_PERSISTED_INVARIANT_VIOLATION`.

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
  {
    event: new OrderCreatedEvent(order.id, total),
    options: { aggregateId: order.id },
  },
  { event: new OrderPaidEvent(order.id), options: { aggregateId: order.id } },
]);
```

Producer input is validated before any database call:

| Field                                                                         | Contract                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`, tenant/aggregate/partition/idempotency/correlation/causation ids | Canonical non-empty string with no leading/trailing whitespace, at most 255 characters. Optional metadata may be `null`/omitted; an empty string is rejected.                                                                                                                                        |
| `payload`                                                                     | Plain JSON object only. Nested values may be finite numbers, strings, booleans, null, arrays, and plain objects. `BigInt`, `Date`, class/collection instances, functions, symbols, `undefined`, circular values, and nesting beyond 100 levels are rejected. UTF-8 serialized size is at most 1 MiB. |
| `headers`                                                                     | Plain object with canonical non-empty keys up to 255 characters and string values up to 8,192 characters. Empty string values are allowed. Total UTF-8 serialized size is at most 64 KiB.                                                                                                            |
| `occurredAt`                                                                  | A valid `Date`; invalid dates are rejected rather than becoming `null` or database time.                                                                                                                                                                                                             |

Invalid input throws `OutboxEnvelopeError` with stable code
`OUTBOX_INVALID_ENVELOPE`, plus `field` and `reason`, before SQL is called.
The reason is one of `invalid_type`, `empty`, `too_long`, `invalid_date`,
`unsupported_json_value`, `circular`, `too_deep`, or `too_large`.

`emitMany()` validates the complete input before staging its first row. When
the Prisma transaction client exposes `$executeRawUnsafe`, it inserts at most
1,000 rows (12,000 bind values) per statement, staying below both PostgreSQL's
65,535 bind limit and practical JavaScript variadic-call limits. Every chunk
uses the same caller-owned transaction client; let an insert rejection escape
the transaction callback so the transaction rolls back. The fallback path also
prevalidates all entries, then inserts them through that same transaction.

`@OnOutboxEvent()` rejects the same event type twice in one decorator, and
discovery fails if the same provider instance, method, and event type is
registered twice. Different handlers may intentionally subscribe to the same
event type and still run as fan-out listeners.

## Admin and DLQ API

`OutboxOperatorService` is the privileged, global control-plane API. It can
read payloads, headers, errors, and statistics for every tenant and can mutate
every eligible row. Do not inject it directly into a tenant-facing HTTP
controller or expose it without application-level operator authorization.
`OutboxAdminService` remains as a deprecated compatibility alias for the same
global service.

```typescript
// Resolve only inside an already-authorized operator control plane.
const operator = app.get(OutboxOperatorService);
const failed = await operator.list({
  status: 'FAILED',
  tenantId: 'tenant-1',
});
const retryResult = await operator.retry(failed[0].id);
if (retryResult.outcome !== 'applied') {
  // Handle not_found, conflict, or lost_claim explicitly.
}

const stats = await operator.getStats();
const health = await operator.getHealth({
  maxOldestPendingAgeMs: 60_000,
  maxFailedCount: 10,
});
```

For tenant-facing tooling, first authorize the caller and derive the expected
tenant from trusted application context, then create a fixed scope. Do not use
a tenant id copied directly from an untrusted URL, body, or header without that
authorization step.

```typescript
// Your guard/policy layer has already proven this identity and tenant access.
const expectedTenantId = request.auth.tenantId;
const tenantAdmin = app
  .get(OutboxTenantAdminService)
  .forTenant(expectedTenantId);

const failed = await tenantAdmin.list({ status: 'FAILED' });
const result = await tenantAdmin.retry(failed[0].id);
const tenantStats = await tenantAdmin.getStats();
```

Every tenant-scoped read, aggregate, mutation, and purge includes the expected
`tenant_id` predicate in its SQL. A cross-tenant id is reported as `not_found`;
the API does not reveal whether that row exists. The package intentionally does
not import or implement RBAC, authentication, guards, or HTTP controllers.

Available methods:

- `getStats()`
- `list(options?)`
- `listPage(options?)`
- `getById(id)`
- `retry(id)`
- `retryMany(ids)`
- `markFailed(id, reason)`
- `purgeSent({ before, limit })`
- `getHealth(options?)`

`retry()` and `retryMany()` only reset `FAILED` rows to `PENDING`; they do not
touch `PROCESSING` rows or reset `retry_count`. A manual retry clears
`last_error` and `processed_at`, then sets `next_attempt_at` to the database's
current time so it is explicitly due now. `markFailed()` only changes
`PENDING` rows; it records the reason and database completion time without
changing `retry_count`. `purgeSent()` only deletes `SENT` rows whose
`processed_at` is before the requested cutoff. No admin mutation overwrites an
active `PROCESSING` claim.

`list()` remains the compatibility range API. It now has a deterministic
display order of `created_at DESC, id DESC`; its `before`/`after` values are
date filters, not continuation tokens, so using only a timestamp from the last
record can still skip or repeat rows that share that timestamp. New code should
use `listPage()`:

```typescript
const first = await operator.listPage({ status: 'FAILED', limit: 50 });
const second = first.nextCursor
  ? await operator.listPage({
      status: 'FAILED',
      limit: 50,
      cursor: first.nextCursor,
    })
  : null;
```

`listPage()` orders by `(created_at DESC, id DESC)` and its versioned opaque
cursor is an exclusive boundary over that tuple. Keep the same filters between
pages. A malformed or unsupported cursor throws `OutboxCursorError` with stable
code `OUTBOX_INVALID_CURSOR`. Tenant-scoped pages retain the fixed tenant SQL
predicate. The cursor order is for deterministic admin traversal only and does
not imply delivery FIFO.

Single-record mutations return a discriminated result:

- `applied`: the compare-and-set transition committed.
- `not_found`: the event id did not exist when the operation observed it.
- `conflict`: the event exists in a source state that the operation does not
  allow; `currentStatus` contains that observed state.
- `lost_claim`: the operation observed an allowed source state, but another
  transaction changed it before the compare-and-set could commit.

The allowed source-state matrix is:

| Operation     | Allowed source | Result                      |
| ------------- | -------------- | --------------------------- |
| `retry`       | `FAILED`       | `PENDING` and due now       |
| `retryMany`   | `FAILED`       | `PENDING` and due now       |
| `markFailed`  | `PENDING`      | `FAILED` with operator note |
| `purgeSent`   | `SENT`         | row deleted                 |
| Any operation | `PROCESSING`   | unchanged                   |

`retryMany()` and `purgeSent()` remain count-returning batch operations. Their
SQL source predicates skip ineligible rows atomically. `retryMany()`
deduplicates ids and executes at most 10,000 ids per statement, below the
PostgreSQL bind limit. Chunks commit independently through the configured
Prisma client: if a later chunk fails, its Promise rejects after earlier chunks
may have committed. Retrying the complete id list is safe because only rows
still in `FAILED` qualify, and the returned count includes only rows changed by
that invocation.

Admin pages use `(created_at DESC, id DESC)` indexes, including a tenant/status
composite path; retention deletes use partial `SENT(processed_at, id)` indexes.
`getStats()` is an exact, point-in-time set of four status aggregates rather
than an estimate, so it still reads every qualifying index/table entry and can
be expensive on a large retained history. Cache or sample outside this package
when an approximate dashboard is sufficient.

Outbox retains `payload`, `headers`, `last_error`, and all metadata for the
entire lifetime of each row. The built-in purge removes only `SENT` rows older
than the requested `processed_at` cutoff; `PENDING`, `PROCESSING`, and `FAILED`
rows have no automatic TTL. Applications own data classification, redaction
before emit/error recording, access control, backup policy, and any approved
archive or failed-row deletion workflow. Do not put credentials or unnecessary
personal data in payloads, headers, or error text.

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

Tenant IDs are validated before any outbox SQL runs. They must be strings,
non-empty, and free of leading or trailing whitespace; the package never trims
or repairs them. `tenantId: undefined` is treated as absent and falls back to
the provider. `tenantId: null` is rejected. Use the explicit global-event escape
hatch when an event intentionally belongs to no tenant:

```typescript
await outbox.emit(tx, new CatalogRebuiltEvent(), {
  tenantScope: 'global',
});
```

| Policy          | Explicit `tenantId`                 | No explicit `tenantId`                     | No resolved tenant |
| --------------- | ----------------------------------- | ------------------------------------------ | ------------------ |
| `optional`      | Used as-is; provider is not queried | Uses `provider.getTenantId()` when present | Stores `NULL`      |
| `required`      | Used as-is; provider is not queried | Uses `provider.getTenantId()` when present | Rejects            |
| `require-match` | Must exactly match the provider     | Uses `provider.getTenantId()`              | Rejects            |

`tenantScope: 'global'` deliberately stores `NULL` under every policy and does
not query the provider. It cannot be combined with `tenantId`.

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

Hooks receive detached deep snapshots and readonly public context types.
Mutating a snapshot does not change canonical delivery/state data or the values
owned by the emitter caller. Runtime freezing is not promised. Hook errors and
rejections are logged and swallowed so observability failures do not alter
delivery state.

| Observation                         | Exact meaning                                                                                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onEmit`                            | The insert and optional `pg_notify` statements were staged successfully in the caller-owned transaction. It runs before that transaction commits, so a later caller error/rollback can leave an `onEmit` observation with no durable outbox row. It is not a commit hook. |
| `onDispatchStart`                   | A live claim is about to attempt delivery. It can still find no local handler, fail, lose its lease, or be retried.                                                                                                                                                       |
| `onDispatchSuccess`                 | Delivery returned successfully and the fenced `SENT` transition was stored. It is omitted when the claim was lost. In publisher mode this still does not mean a downstream consumer completed.                                                                            |
| `onDispatchFailure`                 | Delivery threw and the fenced retry or terminal transition was stored.                                                                                                                                                                                                    |
| `onRetryScheduled` / `onDeadLetter` | The corresponding persisted failure transition was stored.                                                                                                                                                                                                                |
| No local handler                    | The row is marked `FAILED`; no success/failure/retry/dead-letter hook is emitted. `onDispatchStart` may already have observed the attempt.                                                                                                                                |
| Hook throw/reject                   | Logged and swallowed; the delivery transition is unchanged.                                                                                                                                                                                                               |

These callbacks are best-effort metrics/tracing observations, not a durable
compliance audit. If an audit fact must commit atomically with a business write,
write an audit row in that same transaction. If it must survive and be consumed
later, emit a separate durable audit event with an idempotent consumer.

## PostgreSQL LISTEN/NOTIFY Wakeup

Polling remains the source of truth. Wakeup is an optional latency improvement: the emitter sends `pg_notify()` inside the same database transaction, and `OutboxListener` triggers `poll()` when PostgreSQL delivers the notification after commit.

```bash
npm install pg
```

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

If the initial notification client creation, connection, or `LISTEN` query fails
while polling is enabled, the package closes that client, logs the degraded
state, continues with polling, and retries in the background with capped
exponential backoff. Reconnect replaces the old client only after detaching its
listeners when supported and calling `end()`; stale callbacks are ignored even
when a custom client has no listener-removal API. Shutdown cancels pending
reconnect work and closes clients created by an in-flight connection attempt.

If `polling.enabled` is `false` and wakeup is disabled or its initialization is
unavailable, module initialization fails with `OutboxWakeupUnavailableError`
and stable code `OUTBOX_WAKEUP_UNAVAILABLE`; the module does not boot with no
delivery trigger.

## Retry and Backoff

When a listener throws, the event `retry_count` is incremented and the event is
rescheduled as `PENDING`. That failure transition calculates the delay once and
persists `next_attempt_at` from the PostgreSQL clock. Every poller then uses the
stored due time, so a rolling configuration change cannot move an already
scheduled retry. A null `next_attempt_at` is immediately eligible only for a
never-failed row (`retry_count = 0`). The failure threshold uses the per-record
`max_retries` value stored in the database at emit time.

**Fixed backoff** — the delay between attempts is always `initialDelay` ms.

**Exponential backoff** — the delay doubles on every attempt:

```
delay = min(initialDelay * 2^(retry_count - 1), maxDelay)
```

The retry timing values must be safe integers, `initialDelay` must not exceed
`maxDelay`, and `maxDelay` cannot exceed 2,147,483,647 ms. Invalid values fail
module construction. Exponential calculation checks the cap before exponentiation
so a large persisted retry count cannot overflow into an invalid PostgreSQL
interval.

With the defaults (`initialDelay: 1000`, `maxDelay: 86400000`,
`maxRetries: 5`), the event is attempted up to 5 times. After the first failed
attempt, the retry delays are:
1 s → 2 s → 4 s → 8 s → FAILED

`FAILED` events are kept in the table for observability and can be reprocessed
with `OutboxAdminService.retry()` or `retryMany()`.

## Multi-Instance Safety

When multiple application instances run against the same database (horizontal scaling, rolling deployments), each record is claimed on demand using `SELECT ... FOR UPDATE SKIP LOCKED`, a private claim token, and an expiring lease.

- A poller claims only the next record immediately before starting its callback. It does not hold a batch of unstarted claims.
- The active callback renews its lease. Recovery only returns an expired `PROCESSING` lease to `PENDING`, without spending retry budget.
- Every completion compares the event id, `PROCESSING` state, claim token, and unexpired lease. A stale callback cannot write `SENT`, retry, or `FAILED` over a newer claimant.

Delivery remains **at least once**, not exactly once. If heartbeat access is lost, the old callback cannot be forcibly cancelled: its eventual database completion is discarded, but external side effects that occurred before lease loss may overlap with a later retry. Publisher and handler side effects must therefore be idempotent, normally using `record.id` or an application-defined stable key.

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

The claim query's `ORDER BY created_at`, an aggregate lookup index, and rows
returned by `UPDATE ... RETURNING` do not create a serialization boundary.
Events emitted in one transaction can share the same PostgreSQL timestamp;
concurrent pollers may claim different eligible rows, and callback completion
can invert claim order. Strict aggregate/partition FIFO remains a future
`OUT-B01` design rather than a current package guarantee.

Duplicates can occur in these windows:

- A local callback or broker publish succeeds, then the process stops before the
  `SENT` update. The expired claim is recovered and the whole delivery attempt runs
  again.
- Local handlers run sequentially. If one handler succeeds and a later handler
  fails, retry starts again from the first handler.
- If heartbeat access is lost, the lease can expire while the old callback is
  still running. Fencing rejects its late database completion, but cannot undo or
  cancel an external side effect; that side effect can overlap a new attempt.

Make each handler and publisher safe to repeat. A common pattern is to use
`context.eventId` (the same value as `record.id`) as a durable consumer key and
couple the dedupe write atomically with the consumer side effect:

```typescript
@OnOutboxEvent(OrderCreatedEvent)
async handleOrderCreated(
  payload: { orderId: string },
  context: OutboxHandlerContext,
) {
  await this.idempotencyStore.runOnce(context.eventId, async () => {
    await this.orders.applyCreated(payload.orderId);
  });
}
```

An application-defined stable key can be used instead when multiple outbox records
represent the same logical operation. Storing a value in `idempotency_key` only
transports that key; the consumer still owns durable deduplication and its atomicity
boundary.

## Graceful Shutdown

When the NestJS application receives a shutdown signal:

1. The polling scheduler stops accepting new cycles.
2. A claim returned by an in-flight query after shutdown begins is released to `PENDING` with its original claim token and is never dispatched.
3. An active callback keeps its heartbeat and is allowed to complete until the shutdown timeout.
4. Only then does the process exit.

After a process crash or event-loop failure stops heartbeats, the claim becomes recoverable when `lease_expires_at` passes. Recovery runs every tenth poll cycle and does not increment `retry_count`. A callback that hangs while its event loop and database heartbeat remain healthy cannot be distinguished from legitimate long work; use an application-level timeout and terminate the unhealthy process so its lease can expire.

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
<!-- packed-example:publisher:end -->

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

## Ecosystem

| Package                                                                      | Description                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`@nestarc/tenancy`](https://www.npmjs.com/package/@nestarc/tenancy)         | Multi-tenancy for NestJS and Prisma — row-level isolation with zero boilerplate       |
| [`@nestarc/idempotency`](https://www.npmjs.com/package/@nestarc/idempotency) | Idempotent request handling for NestJS — deduplicate API calls at the decorator level |

The `outbox_events` table includes `tenant_id`, aggregate metadata, idempotency keys, correlation ids, and headers so `@nestarc/tenancy`, `@nestarc/idempotency`, broker transports, and internal admin tools can share the same reliability layer.

## License

MIT — see [LICENSE](./LICENSE) for details.
