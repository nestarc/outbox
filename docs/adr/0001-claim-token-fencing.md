# ADR 0001: Fence poller transitions with private claim tokens

- Status: Accepted
- Date: 2026-09-03
- Task: `OUT-M01`

## Context

The poller previously changed rows from `PROCESSING` using only the event id.
It also passed the mutable object returned by PostgreSQL to hooks and delivery
callbacks. A callback could therefore change the id or retry fields used by a
later state transition, and a claimant that no longer owned a row could still
write a late `SENT`, `PENDING`, or `FAILED` state.

## Decision

Each claim assigns a random UUID to a nullable internal `claim_token` column.
Poller-owned terminal and retry transitions are compare-and-set operations on
all three of:

1. the original event id;
2. `status = 'PROCESSING'`; and
3. the original claim token.

A successful transition clears the token. Zero updated rows means the claim
was lost. In that case no dispatch success/failure, retry, or dead-letter hook
is emitted.

The token remains internal and is excluded from `OutboxRecord`. Hooks,
publishers, custom transports, and each local handler receive detached deep
snapshots. Public records and callback contexts are readonly TypeScript types,
but objects are not frozen at runtime; mutation by JavaScript or a type cast is
isolated instead.

Fresh installs include the column and partial unique index. Existing 0.2.x
installs apply the idempotent `upgrade-add-claim-token.sql` migration before
starting the new runtime.

## Consequences

- Late writes from stale claimants cannot overwrite a newer owner or an
  externally changed queued/terminal state.
- Claim fencing does not provide exactly-once delivery and does not replace the
  lease/heartbeat work planned in `OUT-M02`.
- The additive database change is backward compatible with 0.2.x binaries,
  but the migration requirement and readonly public type tightening warrant a
  pre-1.0 minor release (`0.3.0` unless the release task selects a later minor).
