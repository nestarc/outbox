# Changelog

All notable changes to `@nestarc/outbox` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Poller claims now use a private PostgreSQL `claim_token`. Every poller-owned
  `SENT`, retry, and `FAILED` transition compares the event id, `PROCESSING`
  status, and token; a zero-row compare-and-set is treated as a lost claim and
  does not emit success, failure, retry, or dead-letter hooks.
- Publishers, hooks, and local handlers receive detached deep snapshots.
  `OutboxRecord`, dispatch contexts, and handler contexts now expose readonly
  properties at compile time. Runtime freezing is intentionally not part of
  the contract.

### Migration

- Existing 0.2.x databases must apply
  `src/sql/upgrade-add-claim-token.sql` before deploying this runtime. The
  additive nullable column and partial unique index are safe to apply more than
  once.
- Because the required schema migration and readonly public type tightening
  affect consumers, this change is targeted at the next pre-1.0 minor release
  rather than a patch release.

## [0.2.1] — 2026-08-30

### Changed

- Added `@prisma/client` 7.x to the supported peer range while preserving Prisma 5.x and 6.x compatibility.
- Added a Prisma 7 generated-client and required `PrismaPg` adapter E2E path while preserving the Prisma 6 `prisma-client-js` native-engine runtime lane.
- Added an isolated strict consumer gate that installs the packed package with exact NestJS 11.2.1 and Prisma 7.10.0 versions, verifies tarball provenance, compiles public types, and exercises commit, polling, admin stats, and rollback against PostgreSQL.
- Release verification now runs the real PostgreSQL E2E and strict packed modern-consumer gates explicitly.

### Fixed

- The E2E migration loader now applies and asserts all shipped partial indexes instead of dropping statements preceded by SQL comments.

## [0.2.0] — 2026-06-17

### Added

- **Broker-capable publisher mode** — `delivery.mode: 'publisher'` sends `OutboxRecord` objects to an `OutboxPublisher` without requiring local handlers.
- **Stable event metadata** — `OutboxEmitOptions` stores tenant id, aggregate type/id, partition key, idempotency key, correlation/causation ids, headers, and occurred-at timestamp.
- **Handler context** — local handlers receive `OutboxHandlerContext` as a second argument with event id, type, tenant id, retry count, headers, and the full record.
- **Tenant propagation** — optional `OutboxTenantProvider` resolves tenant ids at emit time and restores tenant context for local handlers when `runWithTenant()` is available.
- **Admin/DLQ API** — `OutboxAdminService` exposes stats, list, lookup, retry, retryMany, markFailed, purgeSent, and health methods.
- **Observability hooks** — `OutboxHooks` callbacks cover emit, poll start, dispatch start/success/failure, retry scheduling, and dead-letter events. Hook errors are isolated from delivery state.
- **PostgreSQL wakeup** — optional `wakeup.enabled` support sends `pg_notify()` after event writes and listens with `pg` when installed, while keeping polling as fallback.
- **Bulk `emitMany()`** — uses a single parameterized multi-row insert when the Prisma transaction client exposes `$executeRawUnsafe`.
- **Upgrade SQL** — `src/sql/upgrade-0.1-to-0.2.sql` adds v0.2 metadata columns and indexes idempotently.

### Changed

- `OutboxRecord` now includes metadata fields and `headers`.
- `OutboxTransport.dispatch()` accepts an optional `OutboxHandlerContext` third argument.
- `create-outbox-table.sql` now creates v0.2 metadata columns and aggregate/tenant indexes for new installs.

## [0.1.0] — 2026-04-11

Initial release. Prisma-native transactional outbox for NestJS.

### Added

- **`OutboxModule.forRoot()` / `forRootAsync()`** — NestJS dynamic module
  with `useFactory`, `useClass`, `useExisting` support, following
  `@nestarc/idempotency` conventions.
- **`OutboxEvent`** — abstract base class. Subclasses define
  `static readonly eventType` and constructor properties; `toPayload()`
  serializes own properties, `getEventType()` validates at runtime.
- **`OutboxEmitter`** — `emit(tx, event)` and `emitMany(tx, events)`.
  Uses Prisma `$executeRaw` inside an interactive transaction, so
  business data and outbox row commit or roll back together.
- **`@OnOutboxEvent()`** — method decorator for listener registration.
  Supports multiple event types per handler. Handlers discovered at
  bootstrap via NestJS `DiscoveryService`.
- **Polling delivery** — `OutboxPoller` fetches PENDING events with
  `FOR UPDATE SKIP LOCKED` for multi-instance safety. Polling interval
  and batch size are configurable. Registered dynamically via
  `SchedulerRegistry` so `forRootAsync` runtime values are respected.
- **Retry with backoff** — fixed or exponential strategies. Failure
  threshold uses per-record `max_retries` from the database, so
  configuration changes during rolling deployments do not affect
  in-flight events.
- **Graceful shutdown** — `pollInFlight` counter tracks the entire poll
  lifecycle (including `fetchAndLock` DB queries). `onApplicationShutdown`
  waits for both in-flight polls and active record processing before
  exiting, preventing the race where a poll enters `fetchAndLock` but
  `activeCount` has not yet incremented.
- **Stuck event recovery** — events stuck in `PROCESSING` beyond a
  configurable `stuckThreshold` (default 5 min) are automatically
  reverted to `PENDING`. Recovery runs every 10th poll cycle.
- **No-handler safety** — events with no registered handlers are marked
  `FAILED` (not silently `SENT`) with an explanatory `last_error`,
  preventing silent data loss from typos or missing registrations.
- **`OutboxTransport` interface + `transport` option** — pluggable
  delivery mechanism. `LocalTransport` (direct in-process handler
  invocation) is the default. Custom implementations (e.g. Kafka,
  RabbitMQ) can be swapped via `forRoot({ transport: MyTransport })`.
- **`PrismaLike` type** — exported minimal interface documenting the
  `$executeRaw` / `$queryRaw` contract that `prisma` option instances
  must satisfy.
- **SQL migration** — `src/sql/create-outbox-table.sql` shipped with the
  package. Creates the `outbox_events` table with CHECK constraint and
  three partial indexes (PENDING, PROCESSING, FAILED). Idempotent
  (`IF NOT EXISTS`).
- **All-or-nothing listener strategy** — when multiple handlers are
  registered for the same event type, `LocalTransport` executes them
  sequentially. First failure aborts; the event retries from the
  beginning.

### Technical Details

- **Peer dependencies**: `@nestjs/common` 10/11, `@nestjs/core` 10/11,
  `@nestjs/schedule` 4/5, `@prisma/client` 5/6, `reflect-metadata`
- **Node.js**: >= 20.0.0
- **Build**: `tsc` targeting ES2022 / CommonJS
- **Test coverage**: statements 97.9%, branches 91.7%, functions 96.6%,
  lines 99.4%
- **Tests**: 42 unit + 4 E2E (real PostgreSQL)
