# ADR 0004: Fence admin state transitions with compare-and-set

- Status: Accepted
- Date: 2026-09-03
- Task: `OUT-M08`

## Context

The admin API previously returned booleans for single-record mutations.
`retry()` happened to predicate on `FAILED`, but `markFailed()` overwrote every
state, including an active `PROCESSING` claim. A poller could then complete with
its fenced token after an operator action, leaving callers unable to distinguish
a missing row, an illegal source state, or a concurrent transition.

Admin operations need their own explicit source-state matrix without acquiring
or bypassing a poller's private claim token.

## Decision

Admin state changes use these source predicates and invariants:

| Operation    | Source     | Target/deletion | Invariants                                                                                                             |
| ------------ | ---------- | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `retry`      | `FAILED`   | `PENDING`       | Keep `retry_count`; clear `last_error` and `processed_at`; set `next_attempt_at = NOW()`; clear stale claim fields     |
| `retryMany`  | `FAILED`   | `PENDING`       | Same row invariants as `retry`; return the applied count                                                               |
| `markFailed` | `PENDING`  | `FAILED`        | Keep `retry_count`; set the operator reason and `processed_at = NOW()`; clear `next_attempt_at` and stale claim fields |
| `purgeSent`  | old `SENT` | deleted         | Require `processed_at` before the cutoff; return the deleted count                                                     |

No admin mutation accepts `PROCESSING`. Poller-owned transitions continue to
require the private claim token and live lease; admin code neither reads nor
supplies that token as authority.

`retry()` and `markFailed()` execute one data-modifying CTE that materializes
the observed row, applies a source-state predicate, and classifies the result:

- `applied` when the update commits;
- `not_found` when no row was observed;
- `conflict` with `currentStatus` when the observed source state is illegal;
- `lost_claim` when an allowed state was observed but a concurrent transaction
  changed the row before the update acquired its lock.

`retryMany()` and `purgeSent()` remain count-returning batch APIs. Their SQL
predicates atomically skip ineligible rows; per-id classification is deferred
to the pagination and bulk-performance work in `OUT-M18`.

## Consequences

- An operator cannot force an active callback to `FAILED` without owning the
  poller's fencing contract. Applications must wait for normal completion,
  retry a resulting `FAILED` row, or let lease recovery handle process loss.
- Callers can distinguish stale concurrency from invalid intent and missing
  identifiers without a read-then-write race.
- `markFailed()` is intentionally limited to queued `PENDING` work and records
  a terminal database timestamp.
- Changing `retry()` and `markFailed()` from boolean results to
  `OutboxAdminMutationResult` is a public breaking change and targets the next
  pre-1.0 minor release with the other maintenance changes.
- Tenant predicates and trusted control-plane naming remain `OUT-M07` scope;
  this decision only defines state transition ownership and outcomes.
