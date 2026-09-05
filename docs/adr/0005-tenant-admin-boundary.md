# ADR 0005: Separate operator and tenant admin boundaries

- Status: Accepted
- Date: 2026-09-03
- Task: `OUT-M07`

## Context

The original `OutboxAdminService` is global. Its list filter can be omitted or
chosen by the caller, lookup accepts any event id, stats aggregate the whole
table, and mutations operate without a tenant predicate. Injecting that API
into tenant-facing application code can disclose another tenant's payload,
headers, errors, and operational counts or mutate and purge its rows.

The package cannot decide who a caller is or which tenants that caller may
access. Authentication, RBAC, guards, and HTTP routing belong to the host
application, but SQL isolation must not depend on each controller remembering
to add a filter.

## Decision

`OutboxOperatorService` is the preferred name for the existing global API. It
is a privileged, trusted control-plane service with access to every row.
`OutboxAdminService` remains a deprecated runtime and type alias for backward
compatibility; both names resolve to the same Nest provider instance.

`OutboxTenantAdminService.forTenant(expectedTenantId)` creates a fixed tenant
admin scope. The expected tenant id must be a non-empty canonical string with
no leading or trailing whitespace. The scoped API exposes the same operational
methods, except `list()` has no `tenantId` option and callers cannot replace
the fixed scope per request.

Every scoped SQL path includes `tenant_id = expectedTenantId`:

- `list`, `getById`, `getStats`, and therefore `getHealth`;
- the observation and update portions of `retry` and `markFailed`;
- `retryMany` and both purge candidate selection and deletion.

A lookup or single-record mutation for another tenant behaves exactly like a
missing id and returns `null` or `not_found`. It never reports the other row's
status. Batch operations skip cross-tenant ids and report only the applied
count. Tenant-scoped stats and health are computed only from matching rows.

The host application must authorize the caller and derive
`expectedTenantId` from trusted context before creating the scope. It must not
pass an untrusted path, body, or header tenant id without that authorization.
The package does not import an RBAC library, add guards, or provide an HTTP
controller.

## Consequences

- Existing global consumers continue to work through the deprecated alias,
  while new code communicates privileged intent through the operator name.
- Tenant-facing code gets SQL-enforced isolation for payloads, headers, errors,
  statistics, health, retries, failures, and purges.
- Global events with `tenant_id IS NULL` are intentionally visible only to the
  operator API; a tenant scope never treats them as tenant-owned.
- The new public services and list type are additive, while the alias preserves
  the existing constructor token. The change targets the same next pre-1.0
  minor release as the preceding maintenance work.
- Cursor/pagination and bulk-result performance remain `OUT-M18`; authorization
  policy implementation remains the host application's responsibility.
