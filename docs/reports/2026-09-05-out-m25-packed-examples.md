# OUT-M25 — packed README examples

- Date/owner: 2026-09-05 (Asia/Seoul), Codex.
- Start: local `main@8234baf`, clean tree; branch
  `codex/out-m25-packed-examples`.
- `git fetch --tags origin main:refs/remotes/origin/main` confirmed remote main
  and `v0.2.1^{}` remain `873f95bd86682d4b9515d743efbcfc093a88f450`.
  npm latest remains `0.2.1` with that gitHead. The 30 local-only prerequisite
  commits were preserved; no shared issue claim, commit, push, PR or release was
  performed.
- Host: Node `24.11.1`, npm `11.6.2`; disposable PostgreSQL 16 via compose project
  `outbox-out-m25-20260905`. Port 5433 and the container list were empty before
  startup; the owned compose project was stopped after validation. Tests use only `127.0.0.1:5433/outbox_test` with disposable credentials.

## First RED and correction

The initial fixture extracted the marked handler verbatim from the installed
README and failed `tsc --noEmit`:

```text
src/handler.ts(14,16): error TS2339: Property 'emailService' does not exist on type 'OrderNotificationListener'.
```

The README now declares its email constructor dependency and registers the
service, handler and email providers alongside the global Prisma module. The
async publisher example now imports modules exporting every constructor/factory
dependency and explicitly sets `delivery.mode: 'publisher'`.

A concrete `AsyncLocalStorage` tenant provider is also part of the extracted
README. The broker producer is explicitly application-owned and replaced by a
recording double in the fixture; no Kafka delivery guarantee is inferred.

## Gate and scope

`npm run test:packed-examples` builds and packs once unless both `OUTBOX_TGZ`
and `OUTBOX_TGZ_METADATA` supply an existing artifact. Each lane installs in a
fresh temporary consumer outside the repository, validates tarball lock
integrity and exact versions, extracts nine TypeScript fragments from the
installed README, generates the Prisma client, typechecks with strict Node16
resolution and `skipLibCheck: false`, builds, applies the resolved SQL assets,
and runs the Nest application graph against real PostgreSQL.

Both lanes hold Nest `11.2.3`, Schedule `5.0.1`, Prisma `5.22.0` and TypeScript
`5.9.3` constant. Prisma 5's native engine enables actual database tests without
`pg`; Prisma 7's pg adapter would invalidate that negative control. The present
lane adds `pg@8.20.0`. The absent lane verifies there are no nested/root `pg` or
`@types/pg` lock entries and that resolution from the installed Outbox root
fails. Existing modern consumers retain Prisma 7 coverage.

The runtime assertions cover business/outbox transaction and rollback, handler
DI/discovery, metadata and SENT, async publisher with no handlers, transport
and tenant provider constructor DI through non-global imports, persisted tenant
context restoration/cleanup, require-match rejection before insertion, and the
default optional pg loader. With polling disabled before poller construction,
startup must fail with the public typed error when pg is absent; when present,
module initialization is the LISTEN readiness barrier and post-commit NOTIFY
must deliver the row.

The two README shell fragments are checked for their supported `require.resolve`
paths. Prisma CLI executes the complete fresh SQL and current upgrade twice,
including intact DO blocks. The `psql` shell command itself is not executed.
Historical upgrade fixtures and crash/concurrency contracts remain in the
existing E2E suite.

CI adds the gate to its primary Node 22 cell. Release runs both optional-peer
lanes on Node 22 and Node 24 against the already packed/downloaded artifact;
neither invocation rebuilds or repacks it.

## Validation results

The same candidate artifact contains **134 files**, is **70,778 bytes** packed
and **322,851 bytes** unpacked:

```text
SHA-256: 06d0f7c38f57328ee8d60bcc8c7f32f53ea1cc165a281f477331786e32c6d895
SRI: sha512-dNBOY6PLniYiZxiZiYyqnn6LHnsDbrt+LgFKx3AGs4MLeiVE0gqO5R4lt1Q+CZ6QyRlPxJVNiSREAcnilRdf/A==
```

| Command / gate                                                           | Result                                                                                                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci --strict-peer-deps`                                              | PASS; 645 packages installed                                                                                                          |
| `npm test -- --runInBand`                                                | PASS; 10 suites / 194 tests                                                                                                           |
| `npm run lint`                                                           | PASS                                                                                                                                  |
| `npx --no-install tsc --noEmit -p tsconfig.build.json` / `npm run build` | PASS                                                                                                                                  |
| `npm run test:compatibility-policy`                                      | PASS                                                                                                                                  |
| `npm run test:workflow-policy`                                           | PASS; 19 immutable action references                                                                                                  |
| `node scripts/release-artifact.js pack /tmp/out-m25-artifact`            | PASS; digest above                                                                                                                    |
| `node scripts/test-packed-examples.js` with exact artifact env           | PASS; both absent/present lanes, nine README TypeScript fragments per lane, SQL apply + twice-applied upgrade, all runtime assertions |
| `node scripts/test-package-exports.js` with exact artifact env           | PASS; root/types/two SQL/internal blocking without optional pg                                                                        |
| `npm run test:e2e` on disposable PostgreSQL                              | PASS; 1 suite / 38 tests                                                                                                              |
| `node scripts/test-modern-consumer.js` with exact artifact env           | PASS; Nest 11.2.3 / Prisma 7.10.0 strict typecheck/build/PostgreSQL smoke                                                             |
| Scoped Prettier, JS syntax, `git diff --check`                           | PASS                                                                                                                                  |

All packed gates receive:

```bash
OUTBOX_TGZ=/tmp/out-m25-artifact/package.tgz
OUTBOX_TGZ_METADATA=/tmp/out-m25-artifact/metadata.json
```

The new examples runner also re-verifies the artifact after both lanes. The
artifact was not repacked between examples, export and modern consumer gates.

## Limitations

- Remote Actions were not dispatched; local runtime is Node 24.11.1. Node 22/24
  release executions remain the configured remote gates.
- External Kafka/email side effects are doubles. This verifies dependency
  registration and message mapping, not broker authentication or durability.
- No runtime API, peer range, dependency version, schema or package version
  changed. Documentation/test-only work does not add another semver requirement;
  existing accumulated 0.3.0 migration decisions remain in force.
