# ADR 0006: Runtime configuration and persisted row invariants

- Status: Accepted
- Date: 2026-09-03
- Task: `OUT-M10`

## Context

JavaScript callers can bypass TypeScript option types, and async configuration
factories commonly return parsed environment values. The module previously
accepted zero batches, non-finite intervals, invalid retry limits, and delivery
transport mismatches. PostgreSQL raw-query results were also trusted as
`OutboxRecord` values, allowing corrupt status, counters, dates, or JSON shapes
to reach callbacks or admin callers.

## Decision

Both `forRoot()` and every `forRootAsync()` provider form validate their
resolved options before the `OUTBOX_OPTIONS` token becomes usable. Direct
poller construction applies the same validation defensively.

| Value                              | Accepted range                             |
| ---------------------------------- | ------------------------------------------ |
| `polling.interval`                 | safe integer `1..2147483647` ms            |
| `polling.batchSize`                | safe integer `1..10000`                    |
| `retry.maxRetries`                 | integer `1..2147483647`                    |
| `retry.initialDelay`               | safe integer `0..retry.maxDelay` ms        |
| `retry.maxDelay`                   | safe integer `1..2147483647` ms            |
| `stuckThreshold`, `lease.duration` | safe integer `1..2147483647` ms            |
| `lease.heartbeatInterval`          | positive safe integer below `duration / 2` |
| `lease.heartbeatFailureTolerance`  | integer `0..2147483647`                    |
| `wakeup.reconnectDelay`            | safe integer `1..2147483647` ms            |

Backoff and delivery values must be supported enum members. Local delivery
requires `dispatch()`. Publisher delivery requires `publish()` or the legacy
`dispatch()` adapter and rejects the default `LocalTransport`, which would
otherwise accept an empty handler list without publishing anywhere. A module
with polling disabled must initialize a wakeup path; the existing typed wakeup
error remains authoritative for that availability check.

Raw poller and admin rows are parsed at one boundary. Status, retry counters,
required and nullable dates, payload object shape, and headers object shape are
validated before a record is returned or dispatched. Violations throw
`OutboxPersistedInvariantError` with the event id and field name. A claimed row
must additionally be `PROCESSING` with a non-empty claim token.

Fresh schemas and the idempotent upgrade enforce CHECK constraints for
non-negative retry counts, positive retry limits, object payload/headers, and
cleared claim metadata outside `PROCESSING`. Legacy `PROCESSING` rows may still
have a null lease until recovery, so the database constraint does not require
claim metadata to be present for every processing row.

## Consequences

Invalid configuration and corrupt stored data fail closed instead of being
coerced or delivered. Existing databases must apply
`upgrade-add-invariants.sql`; if validation fails, operators must repair or
quarantine the reported rows explicitly. The new exported error classes and
stricter pre-start behavior are additive but user-visible, so they ship with
the pending pre-1.0 minor rather than a 0.2.x patch.

This decision does not add a full schema-version handshake or historical
upgrade matrix; `OUT-M19` owns those diagnostics and compatibility paths.
