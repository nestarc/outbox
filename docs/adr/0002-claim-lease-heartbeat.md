# ADR 0002: Protect active claims with renewable leases

- Status: Accepted
- Date: 2026-09-03
- Task: `OUT-M02`

## Context

The previous stuck-row recovery changed every old `PROCESSING` row back to
`PENDING` by `updated_at` alone. A legitimate long callback, or a record near
the back of a claimed batch, could therefore be dispatched concurrently by a
second poller. Claim-token fencing stopped the old claimant's late database
write but did not protect the callback while it was running.

## Decision

Each claim writes a private token and `lease_expires_at`. Pollers claim one
record on demand immediately before starting its callback. While that callback
is active, the owner renews the lease with an id, status, token, and unexpired
lease compare-and-set. Terminal and retry transitions use the same ownership
conditions and clear both token and lease.

| Setting                           | Default                        | Contract                                                                                                                                                        |
| --------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lease.duration`                  | `stuckThreshold` or 300,000 ms | Positive finite claim lifetime. Explicit `lease.duration` wins over the deprecated alias.                                                                       |
| `lease.heartbeatInterval`         | `floor(duration / 3)`          | Positive and strictly less than `duration / 2`. Only one heartbeat query may be in flight.                                                                      |
| `lease.heartbeatFailureTolerance` | 1                              | Number of consecutive heartbeat query errors tolerated. The next error abandons completion and stops renewal. A zero-row heartbeat is immediate ownership loss. |
| recovery scan                     | every 10th poll execution      | Requeues expired leases; legacy null leases use `lease.duration` against `updated_at`. Recovery clears ownership and does not increment `retry_count`.          |

The state transitions are:

| State                               | Token / lease                                                           | Allowed poller action                                  |
| ----------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| `PENDING`                           | both null                                                               | claim one row and start its callback immediately       |
| active `PROCESSING`                 | token + future lease                                                    | owner heartbeat or fenced completion                   |
| expired `PROCESSING`                | token + expired lease, or legacy null lease older than `lease.duration` | recovery to `PENDING` without retry-budget consumption |
| `SENT` / `FAILED` / retry `PENDING` | both null                                                               | no late claimant writes                                |

Shutdown stops new claims. If a database claim finishes after shutdown begins,
the poller releases that single unstarted row using its original token. Active
callbacks continue heartbeats while graceful shutdown waits.

When a process crashes or its event loop/heartbeat fails, recovery occurs after
the last successful lease expires and the next tenth-poll recovery scan runs.
A callback that hangs while heartbeat execution remains healthy is deliberately
kept leased because it is indistinguishable from valid long work. Applications
must impose their own callback timeout and terminate an unhealthy process. If a
heartbeat is lost, JavaScript cannot forcibly cancel arbitrary user code; the
old completion is discarded, but already-started external side effects can
still overlap with a retry.

## Consequences

- Long finite callbacks remain exclusively claimed while heartbeats succeed.
- Crash recovery is eventual and deterministic from the last successful lease;
  recovery itself does not count as a delivery attempt.
- Delivery remains at least once. Consumers and publishers must make external
  effects idempotent, normally using the stable outbox record id.
- Fresh installs include the lease column/index. Existing installations apply
  the idempotent `upgrade-add-lease.sql` before starting the new runtime.
- A 0.2.x poller does not heartbeat and leaves the lease null. Deployments must
  drain older pollers before starting lease-aware instances; the null-lease
  fallback preserves delayed recovery but cannot make an old active callback
  lease-aware.
- The optional configuration surface and required schema migration are targeted
  at the same next pre-1.0 minor release as claim-token fencing.
