# OUT-M20 PostgreSQL delivery lifecycle evidence

- Date: 2026-09-03 (Asia/Seoul)
- Scope: `OUT-M20A`, `OUT-M20B`, `OUT-M20C`
- Start ref: local `main@fc782b5`
- Database: disposable PostgreSQL 16, compose project
  `outbox-out-m20-20260903`, loopback port 5433

## Coverage map

| Contract                            | Evidence before OUT-M20                                         | OUT-M20 evidence                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Publisher success and retry         | source unit and general PostgreSQL retry flow                   | terminal publisher rejection persists `FAILED`, final retry count/error, and clears claim/lease                                                 |
| Tenant storage and delivery context | producer policy unit; local transport unit; explicit tenant E2E | one PostgreSQL row derives tenant from `AsyncLocalStorage`, then local delivery restores the persisted tenant only around the handler           |
| Shutdown-time publisher rejection   | general retry unit                                              | barrier-controlled fake publisher rejects after shutdown starts and the row transition remains retriable `PENDING`                              |
| LISTEN readiness                    | listener lifecycle unit                                         | real `pg.Client`: pre-LISTEN notification is lost, post-LISTEN notification delivers the pending row                                            |
| Notification burst                  | fake notification client plus PostgreSQL query coordinator      | real `pg.Client`: 101 observed notifications while the first query is blocked produce one active poll and one queued rerun                      |
| Notification loss fallback          | coordinator unit                                                | real listener plus real polling interval processes a row inserted without `pg_notify`                                                           |
| Reconnect generation                | fake clients and generation unit                                | real first client disconnect, deterministic second `LISTEN` barrier, then notification delivery through generation 2                            |
| Persisted retry due time            | PostgreSQL mixed-config test                                    | exponential 60-second scheduler and fixed zero-delay poller both obey the stored `next_attempt_at`; only a DB due-time change makes it eligible |
| Shutdown claim release              | fake Prisma unit                                                | real claim is persisted, withheld from the poller until shutdown starts, and returned as unclaimed `PENDING` without dispatch                   |
| Historical schema runtime           | checksum/idempotent upgrade and structural guard                | exact v0.1.0 and v0.2.1 fixtures are upgraded, then a preserved pending row is claimed, published, and fenced to `SENT`                         |

## Determinism and failure injection

- Readiness uses completion of the real `LISTEN` query, not a startup delay.
- Notification burst assertions wait until the real client observes all 101
  distinct notifications while the first poll query is behind an explicit
  barrier.
- Reconnect waits for generation 2's real `LISTEN` query before sending the
  delivery notification.
- Notification-loss fallback deliberately bypasses `OutboxEmitter`, so no
  notification is emitted; completion is signalled by `onDispatchSuccess`.
- Shutdown release waits until the real claim update has committed, starts
  shutdown, and only then returns the claimed row to the poller.
- Timeouts are failure guards around event/barrier promises; they are not used
  as success assertions.

## Contract conclusion

OUT-M20 adds no runtime API or schema behavior. It turns the existing
at-least-once, fenced claim, persisted retry, tenant restoration, and optional
LISTEN/NOTIFY fallback contracts into PostgreSQL integration gates. A terminal
`FAILED` row keeps `processed_at` null; `processed_at` continues to mean the
successful `SENT` timestamp rather than a generic terminal timestamp.

## Verification results

- Focused shutdown publisher unit: 1 suite, 51 tests passed.
- Full unit: 10 suites, 194 tests passed.
- PostgreSQL 16 E2E: 1 suite, 38 tests passed.
- Strict packed NestJS 11.2.1 + Prisma 7.10.0 consumer: install,
  generate, typecheck, build, and PostgreSQL smoke passed; SRI
  `sha512-cDQpwCY3BMJqGhlZ8c0vBnuGzEwDr4RFcKcTq6MInys+QmKShzqH4tYRc05yW9FVDcz3Y3hLNEz+eg479SQjkA==`.
- ESLint, build typecheck, clean TypeScript build, scoped Prettier, and
  `git diff --check` passed.
