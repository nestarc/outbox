# Packed README examples

`npm run test:packed-examples` packs once (or accepts both `OUTBOX_TGZ` and
`OUTBOX_TGZ_METADATA`), verifies its digest, and tests the same bytes in clean
projects outside the source checkout. Two consumers use the repository fixture
harness and extract all marked example bodies from the installed package's
README. Missing/duplicate markers fail the gate. A third consumer copies the
complete `examples/quick-start` directory from that installed package and runs
its documented setup and application commands.

The exact tuple is Node 22/24 (CI/release), Nest 11.2.3, Schedule 5.0.1,
Prisma 5.22.0, and TypeScript 5.9.3. Prisma's native engine permits real
PostgreSQL transactions without the `pg` npm package. The second project adds
only `pg@8.20.0`, holding all other dependencies constant. Existing consumers
continue to cover Prisma 6/7 and Nest 10/12.

Both installs use strict peers, check the lock integrity against the input tgz,
and compile with Node16 resolution, strict types and `skipLibCheck: false`.
The absent lane rejects even nested `pg` or `@types/pg` lock entries and checks
resolution from the installed Outbox entry point. No workspace paths or
`NODE_PATH` supply package code or types.

## Run from the package repository

This is a maintainer command: clone the repository and install its dependencies
before running it from the repository root. For an application example, use
[the complete quick start](../../examples/quick-start/README.md).

The smoke test creates/drops `outbox_events`, `packed_example_orders`, and the
`quick_start_*` application tables in the fixed disposable database
`postgresql://test:test@127.0.0.1:5433/outbox_test`.
It intentionally ignores inherited `DATABASE_URL`. Check that port 5433 is free
and run only against your own disposable compose instance:

```bash
docker compose -p outbox-examples up -d --wait
npm run test:packed-examples
docker compose -p outbox-examples down
```

## Contracts

- Quick Start: global Prisma registration, event decorator discovery, handler
  and email injection, event ID forwarding as the email idempotency key, real
  business/outbox transaction, metadata, `SENT`, and rollback of both writes.
- Async publisher: non-global dependency modules export configuration, tenant
  context, and producer; the top-level transport/tenant registrations resolve
  through Nest, and publisher delivery succeeds without local handlers. The
  recorded message preserves event identity, occurrence time, tenant, aggregate,
  partition, correlation, causation, and idempotency metadata; canonical headers
  override a caller-supplied event ID.
- Tenancy: the README's `AsyncLocalStorage` provider restores persisted tenant
  context, clears ambient context afterward, and rejects an explicit mismatch
  before insertion. Synchronous registration uses a global dependency module.
- SQL: the README's supported `require.resolve` paths resolve inside the tgz;
  Prisma CLI applies the complete fresh SQL and current upgrade twice. This
  executes intact `DO` blocks. The `psql` commands themselves are not executed;
  historical-schema upgrade coverage belongs to the existing E2E lane.
- Optional `pg`: ordinary local/publisher/tenant delivery works without it;
  enabling wakeup without `pg` still delivers through polling fallback. The
  installed default `pg` loader completes LISTEN and delivers after post-commit
  NOTIFY before the first 60-second timer can fire. Module initialization is the
  LISTEN readiness barrier. Disabling polling rejects module initialization with
  `OutboxConfigurationError` in both dependency lanes.
- Complete quick start: shipped package pins, Prisma generation, application
  SQL and public outbox SQL setup, strict compile, Nest bootstrap and shutdown,
  automatic `SENT` delivery, and persisted consumer deduplication on replay.

Only email and the application-owned `KafkaProducer` are recording doubles.
No external broker connection/durability is claimed. Fixture-only business
models, imports and app dependency modules surround the unmodified README
fragments. The wakeup test changes only the polling interval before module
construction to distinguish notification delivery from timer fallback. The
complete quick start uses a real database confirmation row as its side effect;
it does not send email or use the recording doubles.
