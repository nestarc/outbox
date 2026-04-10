# Changelog

All notable changes to `@nestarc/outbox` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
