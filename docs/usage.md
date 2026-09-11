# @nestarc/outbox usage and API reference

This reference describes **0.4.0**. It is shipped inside the npm tarball under `docs/usage.md`; read the document from the package version you installed. For the 0.3.0 contract, use the [v0.3.0 README](https://github.com/nestarc/outbox/blob/v0.3.0/README.md). Historical plans and reports are not package usage instructions.

Start with [installation and the quick start](../README.md#installation). PostgreSQL is the only supported database; PostgreSQL 16 is the automated verification baseline. An older minimum version has not been established by this project's tests.

- [Configuration](#configuration)
- [Prisma 7 client](#prisma-7-client)
- [Event metadata and bulk emit](#event-metadata)
- [Admin and DLQ API](#admin-and-dlq-api)
- [Tenant policies](#tenant-policies)
- [Observability hooks](#observability-hooks)
- [Wakeup and reconnect](#wakeup-and-reconnect)
- [Retry and backoff](#retry-and-backoff)
- [Claims and leases](#multi-instance-safety)
- [Delivery and duplicates](#delivery-contract-and-duplicate-handling)
- [Graceful shutdown](#graceful-shutdown)
- [Schema diagnostics and upgrades](#schema-diagnostics-and-upgrades)

## Configuration

Use these runtime settings in `forRoot()` or the `forRootAsync()` factory result. With async registration, `transport`, `tenantProvider`, and `isGlobal` belong at the top level; `tenancy.provider` is only a synchronous registration option. See [the async example](../README.md#async-registration).

| Option                            | Type                                    | Default                             | Description                                                                                                                                                                                  |
| --------------------------------- | --------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma`                          | class ref / instance                    | **required**                        | Client instance, or a class reference in `forRoot()` exported by a global module. Async factories normally return the injected client instance. See `PrismaLike` for the required interface. |
| `polling.enabled`                 | `boolean`                               | `true`                              | Periodic polling must stay enabled. Explicit `false` is rejected at module initialization.                                                                                                   |
| `polling.interval`                | `number`                                | `5000`                              | Milliseconds between polling cycles; safe integer from 1 through `2147483647`                                                                                                                |
| `polling.batchSize`               | `number`                                | `100`                               | Maximum events processed per polling cycle; safe integer from 1 through `10000`                                                                                                              |
| `retry.maxRetries`                | `number`                                | `5`                                 | Maximum delivery attempts before marking an event `FAILED`; positive PostgreSQL `INT` range                                                                                                  |
| `retry.backoff`                   | `'fixed' \| 'exponential'`              | `'exponential'`                     | Backoff strategy between retries                                                                                                                                                             |
| `retry.initialDelay`              | `number`                                | `1000`                              | Initial delay in ms (base for exponential, constant for fixed); non-negative safe integer no greater than `retry.maxDelay`                                                                   |
| `retry.maxDelay`                  | `number`                                | `86400000`                          | Maximum persisted retry delay in ms. Must be no greater than `2147483647`; exponential delays saturate at this value.                                                                        |
| `delivery.mode`                   | `'local' \| 'publisher'`                | `'local'`                           | `local` requires registered `@OnOutboxEvent()` handlers; `publisher` sends records to a broker-style transport without requiring local handlers.                                             |
| `transport`                       | `Type`                                  | `LocalTransport`                    | Custom transport class implementing `OutboxTransport` or `OutboxPublisher`. For `forRootAsync`, register this as a top-level option so Nest can inject its constructor dependencies.         |
| `tenancy.provider`                | `OutboxTenantProvider` / `Type`         | none                                | Optional trusted tenant provider for `forRoot`. `LocalTransport` restores context with `provider.runWithTenant()` when available.                                                            |
| `tenantProvider`                  | `OutboxTenantProvider` / `Type`         | none                                | `forRootAsync` top-level tenant provider registration. Provider classes are constructed by Nest and may inject dependencies from `imports`.                                                  |
| `tenancy.policy`                  | `optional \| required \| require-match` | `optional`                          | Producer provenance policy. `required` rejects a missing tenant; `require-match` also compares an explicit tenant with the provider exactly.                                                 |
| `hooks`                           | `OutboxHooks`                           | none                                | Optional lifecycle callbacks for emit, poll, dispatch success/failure, retry, and dead-letter metrics/tracing. Hook failures are logged and swallowed.                                       |
| `wakeup.enabled`                  | `boolean`                               | `false`                             | Enable PostgreSQL `LISTEN/NOTIFY` wakeup in addition to polling. Requires `pg` or a custom `clientFactory`.                                                                                  |
| `wakeup.channel`                  | `string`                                | `'outbox_events'`                   | Non-empty PostgreSQL notification channel; no NUL and at most 63 UTF-8 bytes.                                                                                                                |
| `wakeup.connectionString`         | `string`                                | `pg` default                        | Connection string for the notification client; an empty string permits the usual `pg` environment defaults.                                                                                  |
| `wakeup.reconnectDelay`           | `number`                                | `5000`                              | Positive safe-integer base reconnect delay in ms. Consecutive failures back off exponentially up to 60 seconds and reset after a successful `LISTEN`.                                        |
| `wakeup.clientFactory`            | `OutboxWakeupOptions['clientFactory']`  | default `pg` client                 | Optional application-owned factory returning a client, null, or a Promise of either; must be a function.                                                                                     |
| `lease.duration`                  | `number`                                | `stuckThreshold` or `300000`        | Positive safe-integer claim lifetime in ms. Active callbacks renew the lease; expired claims are eligible for recovery.                                                                      |
| `lease.heartbeatInterval`         | `number`                                | `max(1, floor(lease.duration / 3))` | Heartbeat interval in ms. Must be positive and less than half of `lease.duration`.                                                                                                           |
| `lease.heartbeatFailureTolerance` | `number`                                | `1`                                 | Non-negative integer count of heartbeat errors tolerated before the claimant abandons completion and lets the lease expire.                                                                  |
| `isGlobal`                        | `boolean`                               | `true`                              | Register the module globally so `OutboxEmitter` is available everywhere                                                                                                                      |
| `stuckThreshold`                  | `number`                                | `300000`                            | Deprecated positive safe-integer compatibility alias for `lease.duration`; ignored when `lease.duration` is set.                                                                             |

Runtime option validation rejects invalid supported values with `OutboxConfigurationError` and code `OUTBOX_INVALID_CONFIGURATION`. This includes `polling.enabled: false`: LISTEN/NOTIFY cannot replace periodic polling. Hook members and notification/tenant-provider callbacks must be functions when supplied; tenancy policy and object shapes are validated too.

Async factories must not return provider-registration fields; those are rejected separately. Nest dependency injection, custom callback execution, and database connectivity can also produce their own errors. `OutboxWakeupUnavailableError` remains exported for compatibility but is not a current startup failure path.
Rows read by the poller and admin APIs are also checked before exposure or
delivery; corrupt status, retry, date, payload, or headers values throw
`OutboxPersistedInvariantError` with code
`OUTBOX_PERSISTED_INVARIANT_VIOLATION`.

## Prisma 7 client

`@nestarc/outbox` supports Prisma 5, 6, and 7 clients. Prisma 7 requires a driver adapter when your application constructs `PrismaClient`; install and configure `@prisma/adapter-pg` and `pg`:

```bash
npm install @prisma/adapter-pg@7 pg
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

| Field                                                     | Contract                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`                                               | Required canonical non-empty string with no leading/trailing whitespace, at most 255 characters.                                                                                                                                                                                                     |
| `tenantId`                                                | Canonical non-empty string, at most 255 characters. `undefined`/omitted falls back to the provider; `null` is rejected. Use `tenantScope: 'global'` for intentional global events.                                                                                                                   |
| aggregate/partition/idempotency/correlation/causation ids | Canonical non-empty string with no leading/trailing whitespace, at most 255 characters. These optional metadata fields may be `null`/omitted; an empty string is rejected.                                                                                                                           |
| `payload`                                                 | Plain JSON object only. Nested values may be finite numbers, strings, booleans, null, arrays, and plain objects. `BigInt`, `Date`, class/collection instances, functions, symbols, `undefined`, circular values, and nesting beyond 100 levels are rejected. UTF-8 serialized size is at most 1 MiB. |
| `headers`                                                 | Plain object with canonical non-empty keys up to 255 characters and string values up to 8,192 characters. Empty string values are allowed. Total UTF-8 serialized size is at most 64 KiB.                                                                                                            |
| `occurredAt`                                              | A valid `Date`; invalid dates are rejected rather than becoming `null` or database time.                                                                                                                                                                                                             |

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
if (failed.length > 0) {
  const retryResult = await operator.retry(failed[0].id);
  if (retryResult.outcome !== 'applied') {
    // Handle not_found, conflict, or lost_claim explicitly.
  }
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
const result = failed.length > 0 ? await tenantAdmin.retry(failed[0].id) : null;
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
cursor is an exclusive boundary over that tuple. Cursor v2 preserves the database UTC timestamp with microsecond precision; public JavaScript `Date` values alone cannot reconstruct it. A v1 cursor is unsupported: discard it and request the first page again. Keep the same filters between pages. A malformed or unsupported cursor throws `OutboxCursorError` with stable
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

## Tenant policies

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

Use hooks for metrics, traces, and diagnostic logs without adding an OpenTelemetry dependency to the package.

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
| `onPollStart`                       | A polling cycle began; this does not imply that an eligible event exists or that any delivery succeeded.                                                                                                                                                                  |
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

## Wakeup and reconnect

If the initial notification client creation, connection, or `LISTEN` query fails
while polling is enabled, the package closes that client, logs the degraded
state, continues with polling, and retries in the background with capped
exponential backoff. Reconnect replaces the old client only after detaching its
listeners when supported and calling `end()`; stale callbacks are ignored even
when a custom client has no listener-removal API. Shutdown cancels pending
reconnect work and closes clients created by an in-flight connection attempt.

Periodic polling is required. `polling.enabled: false` is rejected with `OutboxConfigurationError` (`OUTBOX_INVALID_CONFIGURATION`), even when wakeup is enabled. Notifications are transient and cannot recover a retry due later, an expired lease, or a missed notification by themselves. The scheduler remains responsible for eventual work discovery.

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
with `OutboxOperatorService.retry()` or `retryMany()`.

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
can invert claim order. Strict aggregate/partition FIFO is not implemented.

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

Enable Nest shutdown hooks in the application bootstrap to handle operating-system signals:

```typescript
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(3000);
```

Calling `app.close()` also runs the Nest shutdown lifecycle. During that lifecycle:

1. The scheduler stops accepting new cycles and discards queued polling work.
2. A claim returned by an in-flight query after shutdown begins is released to `PENDING` with its original claim token and is never dispatched.
3. An active callback keeps its heartbeat while the poller waits for in-flight work, up to a fixed **30 seconds**.
4. On timeout the poller logs the remaining work and returns control to Nest. It does not cancel callback code, force a process exit, or guarantee that external side effects have stopped.

Set application-level callback/network timeouts and a process-manager termination grace period that accommodates shutdown. The package has no public option to change the 30-second drain timeout.

After a process crash or event-loop failure stops heartbeats, the claim becomes recoverable when `lease_expires_at` passes. Recovery runs every tenth poll cycle and does not increment `retry_count`. A callback that hangs while its event loop and database heartbeat remain healthy cannot be distinguished from legitimate long work; an application-level timeout and process supervision must handle that case.

## Schema diagnostics and upgrades

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
