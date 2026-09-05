# OUT-M18/M19 admin performance and schema compatibility evidence

- Date: 2026-09-03 (Asia/Seoul)
- PostgreSQL: 16, disposable Compose project `outbox-out-m18-m19-20260903`
- Runtime target: next pre-1.0 minor (`0.3.0` by default)
- Scope: admin pagination/retry/stats/retention and v0.1/v0.2 schema diagnosis/upgrade

## Historical fixture provenance

The E2E fixtures are byte-for-byte copies of the public tag assets. The test
hashes each file before applying it, so a fixture edit cannot silently change
the compatibility claim.

| Release tag | Fixture                                            | SHA-256                                                            |
| ----------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| `v0.1.0`    | `test/e2e/fixtures/v0.1.0-create-outbox-table.sql` | `d6b276fce130d9a494390116f296939ef5725ca210c6ebfd2ea6e1b9e86a2634` |
| `v0.2.1`    | `test/e2e/fixtures/v0.2.1-create-outbox-table.sql` | `0f17f8a40226f1d6c13172f81f4163cc528d883d13b1381f07db7cec159829cb` |

For each fixture the test created the historical table, inserted a legacy
failed row, observed `OUTBOX_SCHEMA_MISMATCH` with actual version `0.1.x` or
`0.2.x`, applied `src/sql/upgrade-to-current.sql` twice, then verified the
current structural inventory and preserved row values. The matrix completed in
129 ms inside the full PostgreSQL E2E run.

## Admin workload evidence

The automated PostgreSQL test uses a 20,000-row, four-status, 20-tenant history
and runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for cursor and retention
queries. The final plans use `idx_outbox_tenant_status_admin` for a
tenant+status cursor, `idx_outbox_tenant_admin` for an unfiltered tenant cursor,
and `idx_outbox_sent_retention` for retention. The combined seed, plans, and
exact stats assertion completed in 285 ms. A separate 10,001-row failed batch
completed in 192 ms, used two statements, deduplicated a repeated id, and
changed exactly 10,001 rows.

An initial plain-text control run before splitting the general tenant cursor
from the tenant+status cursor produced:

| Query                               | Observed plan                                                                       | Execution |
| ----------------------------------- | ----------------------------------------------------------------------------------- | --------: |
| tenant + failed cursor, limit 51    | `Index Scan using idx_outbox_failed`; tenant predicate applied during scan          |  0.075 ms |
| sent retention, limit 50            | `Index Only Scan using idx_outbox_sent_retention`                                   |  0.031 ms |
| four exact global status aggregates | pending/processing index-only scans, failed bitmap index scan, sent sequential scan |  3.617 ms |

That first plan motivated separate `(tenant_id, created_at, id)` and
`(tenant_id, status, created_at, id)` indexes; the final automated plan uses
both as intended. PostgreSQL can still choose another semantically equivalent
index as data distribution changes. Exact global stats must visit every
qualifying entry and are intentionally not advertised as constant-time. The
implementation separates status aggregates so the planner can choose each
partial index independently, but a sequential scan can still be cheaper for a
dense status such as `SENT`.

## Contract decisions

- `retryMany()` keeps its count-returning API, deduplicates input, and executes
  at most 10,000 UUID binds plus status/tenant values per statement.
- Chunks use the configured Prisma client without inventing a package-owned
  transaction. A later failure rejects after earlier chunks may have committed;
  replaying the full request is safe because only remaining `FAILED` rows match.
- Cursor/tenant, processing age, and sent retention receive purpose-built
  indexes. `purgeSent()` remains bounded and `SENT`-only.
- Payloads, headers, error text, and metadata live as long as their row.
  Automatic retention exists only through explicit `purgeSent()` calls; the
  application owns redaction, authorization, backup, archival, and failed-row
  policy.
- Startup diagnosis is structural and fail-closed. It reports required schema
  `0.3.0`, a detected historical/incomplete version, and missing objects; it
  never performs an automatic migration.
- The additive error/export/indexes plus mandatory unified migration are part
  of the accumulated next pre-1.0 minor rather than a `0.2.x` patch.

## Verification result

- Unit: 10 suites, 193 tests passed.
- PostgreSQL E2E: 1 suite, 31 tests passed.
- Exact v0.1.0/v0.2.1 checksum and twice-applied upgrade: passed.
- 10,001-row retry and 20,000-row plan fixtures: passed.
- Packed artifact: 134 files, 69,468 bytes,
  `sha512-argw2M3X4tazx0m83Sbssfei210W9dd6rUomJGxBrJqFOchkhcLeP8VJGUtrnznWOepC7i3Z1REdjZSLyXCAJg==`
  (SHA-256 `7f0cb8de969b4ab715b72b9687482c38cc2b8d727f07c495a42fd30e01778cb3`).
- The same tarball passed strict packed PostgreSQL consumers with NestJS
  11.2.1/Prisma 7.10.0 and NestJS 10.4.22/Prisma 5.22.0. Both resolved and
  inspected `upgrade-to-current.sql`; artifact verification also checked the
  packed README commands.
