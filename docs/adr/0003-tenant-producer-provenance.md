# ADR 0003: Make tenant producer provenance explicit

- Status: Accepted
- Date: 2026-09-03
- Task: `OUT-M06`

## Context

Tenant resolution previously treated property presence as an explicit
override. Passing `{ tenantId: undefined }` therefore bypassed the configured
provider and persisted `NULL`. Explicit, provider-derived, and global events
also had no policy for missing context, mismatches, invalid runtime values, or
whitespace normalization.

The outbox package must remain independent of `@nestarc/tenancy`, but it needs a
producer-side contract that prevents an ambient tenant from being silently
replaced or discarded.

## Decision

`tenancy.policy` defines producer provenance and defaults to `optional` for
compatibility with applications that do not use tenancy.

| Policy          | Explicit `tenantId`               | No explicit `tenantId` | Provider has no tenant |
| --------------- | --------------------------------- | ---------------------- | ---------------------- |
| `optional`      | Use it; do not query the provider | Use provider value     | Persist `NULL`         |
| `required`      | Use it; do not query the provider | Use provider value     | Reject                 |
| `require-match` | Require an exact provider match   | Use provider value     | Reject                 |

An explicit `tenantScope: 'global'` is the escape hatch for an event that
intentionally belongs to no tenant. It persists `NULL` under every policy,
bypasses provider lookup, and cannot be combined with `tenantId`.

`tenantId: undefined` is absence, not an override, and therefore follows the
provider fallback. `tenantId: null` is rejected so global intent cannot be
confused with an accidental nullable value. Both explicit and provider values
must be strings, non-empty, and have no leading or trailing whitespace. Values
are compared and stored exactly; the package never trims, coerces, or otherwise
repairs a tenant id. All resolution and validation completes before the insert,
including before a bulk insert containing multiple events.

The configured provider instance is the trusted provenance source for
`require-match`. The comparison is case-sensitive and byte-for-byte at the
JavaScript string level. Provider absence or a provider returning nullish data
cannot prove a match and fails closed. The explicit global escape hatch is
deliberate application authority and does not consult the provider.

## Consequences

- Existing non-tenant applications retain the `optional` default.
- Applications that require tenant attribution can fail closed with
  `required`; applications accepting explicit tenant input can verify it
  against ambient trusted context with `require-match`.
- `OutboxEmitOptions.tenantId` no longer accepts `null`; callers migrate global
  events to `tenantScope: 'global'`.
- The new option and tightened public emit type target the same next pre-1.0
  minor release as the preceding maintenance changes.
- Tenant-aware admin authorization remains `OUT-M07`; this decision only owns
  producer attribution. Provider construction through async Nest DI remains
  `OUT-M11`.
