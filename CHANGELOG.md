# Changelog

All notable changes to `@nestarc/outbox` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] — 2026-09-05

### Migration

This pre-1.0 minor requires a database upgrade and caller changes. Follow the
[0.3.0 upgrade steps](README.md#upgrading-to-030): drain old pollers, apply the
unified SQL migration, move to Node 22/24, update async provider registrations,
replace nullable tenant overrides, handle structured admin mutation results,
and remove unsupported deep imports. Delivery remains at-least-once.

### Added

- Critical per-file coverage gates for poller transitions, admin CAS, and
  listener reconnect/shutdown paths, with a documented PostgreSQL regression
  contract. CI and release coverage artifacts now include the tested commit,
  source/report hashes, and actual installed runtime versions. The Jest harness
  also loads Nest 12 ESM dependencies for source unit and PostgreSQL tests.

- README local, async publisher, tenant provider, wakeup, and SQL examples now
  compile and run from the installed tarball in strict consumers with and
  without optional `pg`. CI/release gates verify Nest dependency visibility,
  PostgreSQL transactions and tenant restoration, and notification-only
  delivery. Examples now register handler dependencies and import the async
  publisher's configuration, tenant context, and broker provider modules.

- Runtime startup now validates the required outbox columns, indexes, and
  constraints and throws `OutboxSchemaError` with stable code
  `OUTBOX_SCHEMA_MISMATCH`, required/actual versions, and missing objects before
  poller SQL can fail generically. A unified shipped
  `src/sql/upgrade-to-current.sql` upgrades exact v0.1.0 and v0.2.1 fixtures
  idempotently.
- Admin APIs now expose `listPage()` with deterministic
  `(created_at DESC, id DESC)` traversal, an exclusive opaque versioned cursor,
  and `nextCursor`. Invalid cursors throw `OutboxCursorError` with stable code
  `OUTBOX_INVALID_CURSOR`; the existing `list()` Date-filter API remains
  available for compatibility.
- Producer envelope failures now throw `OutboxEnvelopeError` with stable code
  `OUTBOX_INVALID_ENVELOPE` and machine-readable `field`/`reason` details.

### Fixed

- `retryMany()` now deduplicates ids and uses 10,000-id statements instead of
  risking PostgreSQL's bind limit. Admin cursor, tenant/status, processing-age,
  and `SENT` retention paths have purpose-built indexes, while exact stats use
  status-specific aggregates instead of one monolithic history aggregate.
- Release workflow authorization now permits real npm publication only for a
  matching `v*.*.*` tag whose commit is on `main`. Manual dispatch is dry-run
  only; npm OIDC and GitHub `contents: write` live in separate jobs, and every
  action in the privileged workflow is pinned to a reviewed commit SHA.
- Runtime options from both `forRoot()` and `forRootAsync()` are now validated
  as bounded safe integers and supported enum/transport combinations before
  startup. Invalid configuration throws the typed
  `OutboxConfigurationError`; polling-disabled configurations still require a
  usable wakeup path at module initialization.
- Poller and admin reads now fail closed with the typed
  `OutboxPersistedInvariantError` when stored status, retry counters, dates, or
  JSON object shapes are corrupt, so malformed records cannot reach delivery
  callbacks or be exposed as valid admin records.
- PostgreSQL wakeup initialization now degrades to polling after client,
  connection, or `LISTEN` failures. Reconnect uses capped exponential backoff,
  generation-fences stale callbacks, detaches supported listeners, closes the
  replaced client, handles both `error` and `end`, and leaves no reconnect work
  after shutdown. Disabling polling while wakeup is disabled or unavailable
  instead throws the typed `OutboxWakeupUnavailableError` with stable code
  `OUTBOX_WAKEUP_UNAVAILABLE`.
- Poll interval, PostgreSQL notification, and manual triggers now share a
  single-flight coordinator. Concurrent triggers are coalesced into at most
  one queued rerun, background failures are logged without becoming unhandled
  rejections, and shutdown drops queued work while waiting for the active poll.
- `emit()` and `emitMany()` now reject invalid dates, BigInt, circular or
  non-plain JSON, unsupported JSON values, oversized payloads/headers, blank or
  overlong identifiers, and invalid headers before calling the database.
  `emitMany()` prevalidates the complete input and chunks inserts at 1,000 rows
  on the same caller-owned transaction, below PostgreSQL and JavaScript
  argument limits.
- Duplicate event entries in one `@OnOutboxEvent()` and duplicate discovery of
  the same provider instance/method/event tuple now fail fast, while distinct
  handlers retain intentional fan-out.

### Changed

- Development NestJS 11 controls now use exact 11.2.3, with compatible
  Jest/Babel and Express dependency refreshes for reported development-only
  advisories. Prisma 5/6/7 controls and the production audit-zero gate remain;
  the Prisma 7 CLI exception awaits an upstream supported fix (OUT-M22B).
- The package now declares an explicit export map for the CommonJS/type root
  and the documented fresh/current SQL migration paths. Accidental `dist/**`
  and component-migration deep imports are intentionally blocked in 0.3.0;
  consumers must import runtime/types from the root and resolve
  only `create-outbox-table.sql` or `upgrade-to-current.sql`.
- The development lint toolchain now uses the supported ESLint 10 flat-config
  line, TypeScript ESLint 8, and current Prettier compatibility rules. This
  removes the legacy ESLint 8 dependency path without changing package runtime
  dependencies or the production audit-zero gate.

- The minimum Node.js engine is now 22. Node 20 reached upstream EOL on
  2026-03-24 and is removed in 0.3.0. Node 22 and 24 are required runtime
  controls; Node 26 remains an allowed-failure pre-LTS canary.
- NestJS 12 is now included in the `@nestjs/common` and `@nestjs/core` peer
  ranges, paired with `@nestjs/schedule` 12. The exact NestJS 12.0.1 + Schedule
  12.0.1 + Prisma 7.10.0 candidate passed strict packed type/module and
  PostgreSQL consumer verification before the peer ranges were widened.
- `forRootAsync()` now separates factory-owned runtime configuration from
  top-level Nest registrations. Custom transports and tenant provider classes
  are constructed by Nest with dependencies from `imports`; factory-returned
  `transport`, `tenancy.provider`, or `isGlobal` values are rejected instead
  of being ignored or instantiated with a bare constructor. The public async
  factory type is tightened in 0.3.0.
- Global admin access is now named `OutboxOperatorService` and documented as a
  privileged control-plane API; `OutboxAdminService` remains a deprecated
  compatibility alias. `OutboxTenantAdminService.forTenant()` creates a fixed
  tenant scope whose reads, stats, health checks, retries, failures, and purges
  all include the expected tenant predicate without adding an RBAC dependency.
- Admin `retry()` and `markFailed()` now use compare-and-set source-state
  transitions and return `applied`, `not_found`, `conflict`, or `lost_claim`.
  `markFailed()` accepts only `PENDING`; all admin mutations leave active
  `PROCESSING` claims untouched. Retry, failure, and purge invariants are now
  fixed by an explicit operation matrix.
- Tenant producer provenance is now controlled by
  `tenancy.policy: 'optional' | 'required' | 'require-match'`. Undefined tenant
  ids fall back to the configured provider; null, non-string, blank, and
  non-canonical whitespace values fail before SQL. Global events use the
  explicit `tenantScope: 'global'` escape hatch, and `require-match` rejects
  explicit/provider mismatches.
- Retry failures now persist a PostgreSQL-clock `next_attempt_at`; every
  poller claims from that stored due time instead of recalculating eligibility
  from its local backoff configuration. `retry.maxDelay` bounds exponential
  delay safely, and `OutboxRecord.nextAttemptAt` exposes the schedule.
- Admin retry keeps `retry_count`, clears `last_error` and `processed_at`, and
  writes `next_attempt_at = NOW()` so the row is explicitly due immediately.
- The README now defines polling, local-handler, and publisher delivery as
  at-least-once, documents every known duplicate window, and clarifies that
  `idempotency_key`, `partition_key`, and Outbox `SENT` do not provide consumer
  deduplication, FIFO, or downstream-completion guarantees.
- Hook contexts are readonly detached snapshots. The hook contract now states
  that `onEmit` observes a staged attempt before caller transaction commit,
  documents rollback/no-handler/hook-failure meaning, and directs durable
  compliance audit facts to transactional rows or durable events.
- Admin ordering is deterministic for traversal only. Equal transaction
  timestamps, `UPDATE ... RETURNING`, aggregate indexes, concurrent claims,
  retries, and callback duration do not provide global, aggregate, or partition
  FIFO; strict FIFO remains deferred to `OUT-B01`.
- Pollers now claim one record on demand and protect its active callback with a
  renewable PostgreSQL lease. Recovery only requeues expired leases, does not
  consume retry budget, and stale completions require both the original claim
  token and an unexpired lease.
- `stuckThreshold` remains as a deprecated compatibility alias for
  `lease.duration`. New `lease.heartbeatInterval` and
  `lease.heartbeatFailureTolerance` options define heartbeat timing and loss.
- Poller claims now use a private PostgreSQL `claim_token`. Every poller-owned
  `SENT`, retry, and `FAILED` transition compares the event id, `PROCESSING`
  status, and token; a zero-row compare-and-set is treated as a lost claim and
  does not emit success, failure, retry, or dead-letter hooks.
- Publishers, hooks, and local handlers receive detached deep snapshots.
  `OutboxRecord`, dispatch contexts, and handler contexts now expose readonly
  properties at compile time. Runtime freezing is intentionally not part of
  the contract.

### Testing

- Release verification now packs one allowlisted tarball, records its SHA-512
  SRI and SHA-256 digest, and passes those exact bytes through every packed
  consumer, the Node 24 control, manual dry-run, and npm publish. Reruns skip
  an existing version only when registry integrity is identical; post-publish
  verification checks npm signatures plus the provenance subject, tag ref,
  source commit, and release workflow before the GitHub Release is created.
- CI requires Node 22 and 24 controls, including exact NestJS 12.0.1 + Schedule
  12.0.1 + Prisma 7.10.0 strict packed PostgreSQL consumers. Release
  verification requires the same Node controls, while Node 26 is isolated in
  a non-blocking canary until it reaches LTS.
- CI and release verification now include Node 22 + NestJS 10.4.22 + Schedule
  4.1.2 + exact Prisma 5.22.0. The isolated strict consumer installs the packed
  tarball, generates the legacy Prisma client, typechecks public declarations,
  loads the shipped SQL asset, and exercises emit/poll/admin state against
  PostgreSQL. Prisma 6.19.3 runs through the same packed legacy fixture, while
  the existing Prisma 7.10.0 modern consumer remains in place.
- A repository-local release policy fixture rejects mutable action refs,
  manual real-publish paths, shared npm/GitHub release authority, and verify
  jobs with write permissions.
- Unit contracts cover invalid sync/async runtime configuration, delivery
  transport mismatches, and corrupt persisted rows. PostgreSQL E2E verifies the
  new retry, JSON-object, and non-processing-claim CHECK constraints and their
  idempotent upgrade.
- Unit contracts cover hook rollback/mutation isolation, stable envelope
  failures, full-batch prevalidation, bulk chunking, duplicate discovery, and
  cursor decoding. PostgreSQL E2E traverses rows with an identical
  `created_at` without gaps or duplicates.
- PostgreSQL E2E now gates concurrent two-poller initial claims, active lease
  heartbeats, expired-lease recovery, stale completions, publisher acceptance
  before `SENT` process loss, and notification/poll fallback coalescing. The
  existing CI and release PostgreSQL jobs run this suite for their supported
  runtime tuples.
- PostgreSQL E2E now also covers publisher terminal `FAILED`, provider-derived
  tenant persistence with ambient handler-context restoration, real
  LISTEN-before/after readiness, real notification burst coalescing, polling
  fallback after notification loss, reconnect generations, shutdown claim
  release, mixed retry configurations, and runtime delivery after exact
  v0.1.0/v0.2.1 fixture upgrades.

### Migration

- Existing 0.1.x and 0.2.x databases must drain old pollers and apply the
  unified `src/sql/upgrade-to-current.sql` before deploying this runtime. The
  additive nullable columns and partial indexes are safe to apply more than
  once. The unified upgrade is idempotent but validates the existing table and
  intentionally fails on corrupt rows. It makes existing pending/processing
  retries due at migration time and rebuilds the pending index around
  `next_attempt_at`.
  Legacy `PROCESSING` rows with a null lease retain the configured duration as
  their recovery threshold. Drain 0.2.x pollers before starting the new runtime
  because older pollers neither heartbeat active claims nor persist due times.
- Because the required schema migration and readonly public type tightening
  affect consumers, and the admin single-record mutation result changed from a
  boolean to a discriminated union, this change is targeted at the next
  pre-1.0 minor release rather than a patch release.
- The additive cursor API/errors and stricter producer envelope validation are
  also targeted at the next pre-1.0 minor release. Existing Date filters are
  source-compatible but remain range filters rather than pagination cursors.
- Raising the Node engine floor and removing Node 20 are also intentionally
  targeted at that next pre-1.0 minor release. Node 20 consumers must move to
  Node 22 or remain on the 0.2.x release line.

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
