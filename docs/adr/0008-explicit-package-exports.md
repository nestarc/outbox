# ADR 0008: Explicit root and SQL package exports

- Status: Accepted
- Date: 2026-09-04
- Task: `OUT-M23`

## Context

`@nestarc/outbox@0.2.1` ships a CommonJS root plus every file under `src/sql`,
but its manifest has no `exports` map. Node therefore treats compiled modules,
declaration files, source maps, and all historical/component migration SQL as
addressable deep imports even though the documented consumer surface uses only:

- `@nestarc/outbox`;
- `@nestarc/outbox/src/sql/create-outbox-table.sql` for fresh installs; and
- `@nestarc/outbox/src/sql/upgrade-to-current.sql` for every supported upgrade.

The published v0.2.1 tarball was fetched directly during this decision: it has
97 entries, 33,383 packed bytes, and no export map. It exposes the root build,
all compiled module paths, `create-outbox-table.sql`, and the then-current
`upgrade-0.1-to-0.2.sql` simply because those files are present.

Repository-wide usage and the packed Prisma 5/7 consumers use the root and
those two SQL paths. The older `upgrade-0.1-to-0.2.sql` and component migrations
remain packaged as release/migration provenance, but no current consumer is
directed to import them. No evidence supports treating `dist/**`, declaration
files, source maps, or component migrations as public subpaths.

## Decision

The next pre-1.0 minor exposes exactly the CommonJS/type root and the two
documented SQL paths through `package.json#exports`. All other subpaths are
package-private, even when their files remain in the tarball.

The root keeps `main` and `types` for older resolvers. Its conditional export
lists `types` first, then `require` and `default`, all pointing at the existing
CommonJS build. SQL is exported with the established path spelling so current
`require.resolve()` commands do not change.

## Compatibility and verification

Adding `exports` makes accidental deep imports fail with
`ERR_PACKAGE_PATH_NOT_EXPORTED`; this deliberate tightening ships in the same
next pre-1.0 minor as the other accumulated contract changes (currently
targeted at `0.3.0`). The migration note tells consumers to import from the
root or use one of the two supported SQL paths.

The release artifact verifier checks the exact export map. A strict isolated
packed consumer installs without optional `pg`, type-checks public root types,
loads the CommonJS root, resolves and reads both SQL assets, proves representative
internal JavaScript and component SQL paths are blocked, and confirms `pg` was
not installed transitively.

## Consequences

- The supported package surface is reviewable and cannot grow accidentally.
- Internal file movement no longer creates undocumented breaking changes.
- Historical SQL remains auditable inside the tarball without becoming a
  supported application import path.
- A consumer using an undocumented deep import must migrate before upgrading.
