# OUT-M22B/C development dependency audit follow-up

- Date: 2026-09-05 (Asia/Seoul)
- Start: local `main@5319d79`; work branch `codex/out-m22bc-dev-audit`
- Scope: supported Prisma 7 fix investigation and compatible Nest/Jest/Babel
  development dependency updates; package version, runtime API, and peer ranges
  are unchanged.
- Outcome: `OUT-M22C` remediation verified; `OUT-M22B` is blocked on a supported
  upstream Prisma 7 release.

## Baseline and reproducible online evidence

The first RED was an online `npm audit --json` against the original lockfile:
nine affected dependency nodes (six high, one moderate, two low). These are
audit dependency counts, including propagated parent findings, rather than nine
independent vulnerabilities. All reported nodes are in the development tree.

The raw [before audit](2026-09-05-out-m22bc-audit/audit-before.json),
[after audit](2026-09-05-out-m22bc-audit/audit-after.json), and
[production audit](2026-09-05-out-m22bc-audit/audit-production.json) are preserved.
[Metadata](2026-09-05-out-m22bc-audit/metadata.json) records the registry, capture
time, Node/npm versions, command exit codes, before/after lock SHA-256, and raw
artifact SHA-256 values. These are successful online audit responses; exit 1
means findings, not a registry error. No offline empty response is used.

| Audit                            | High | Moderate | Low | Total |
| -------------------------------- | ---: | -------: | --: | ----: |
| Before, full lock                |    6 |        1 |   2 |     9 |
| After, full lock                 |    4 |        0 |   0 |     4 |
| After, production (`--omit=dev`) |    0 |        0 |   0 |     0 |

## OUT-M22B: supported fix unavailable

The registry's [complete Prisma 7 version list](2026-09-05-out-m22bc-audit/prisma7-versions.json)
ends at `7.10.0`. The [`latest` tag](2026-09-05-out-m22bc-audit/prisma-dist-tags.json)
is `8.0.0-rc.13`, which is neither a stable Prisma 7 update nor within the
declared Prisma 5/6/7 support decision.

The published [`prisma@7.10.0` dependencies](2026-09-05-out-m22bc-audit/prisma-7.10.0-dependencies.json)
pin `mysql2@3.15.3` and `@prisma/config@7.10.0`; that
[config package](2026-09-05-out-m22bc-audit/prisma-config-7.10.0-dependencies.json)
pins `deepmerge-ts@7.1.5`. A compatible lock refresh cannot replace these exact
pins. The deepmerge fix starts at major 8 according to the
[upstream advisory](https://github.com/RebeccaStevens/deepmerge-ts/security/advisories/GHSA-ggr8-5vv4-36mx).
The audit also reports MySQL2 authentication downgrade and compressed-protocol
decompression findings; their exact advisory ranges are retained in the raw
JSON. npm proposes Prisma `6.19.3`, which would remove the Prisma 7 control.

Accordingly, Prisma CLI/client/adapter remain exact `7.10.0`, and Prisma 5/6/7
packed controls remain present. No forced downgrade, prerelease adoption, or
out-of-range transitive override was applied. The four remaining high audit
nodes are `deepmerge-ts`, `@prisma/config`, `mysql2`, and `prisma`.

| Owner              | Scope                                        | Reason                                                                                                                   | Expiry / next action                                                                                                                                                                                                                                                                 |
| ------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outbox maintainers | Prisma CLI development-only dependency graph | Supported Prisma 7 still pins the affected dependencies; the shipped Outbox package has no runtime dependency on the CLI | Keep the original 2026-10-04 expiry, or the next supported Prisma patch, whichever is earlier. Recheck published dependency metadata, update CLI/client/adapter and all exact controls together, run full online/production audits, generate, E2E, and packed Prisma 5/6/7 controls. |

This exception does not assert that the vulnerable dependencies are fixed or
safe for arbitrary inputs. Prisma config is repository-controlled, and this
repository's database tests use PostgreSQL. A release owner must reassess any
still-open exception at expiry; `BLOCKED` does not renew it automatically.

## OUT-M22C: compatible remediation

| Path                                          | Before       | After        |
| --------------------------------------------- | ------------ | ------------ |
| Nest common/core/platform-express/testing     | exact 11.2.1 | exact 11.2.3 |
| Jest/ts-jest → Babel core                     | 7.29.0       | 7.29.7       |
| Babel → browserslist                          | 4.28.2       | 4.28.9       |
| Babel coverage → load-nyc-config → js-yaml    | 3.14.2       | 3.15.2       |
| Nest platform-express → Express → body-parser | 2.2.2        | 2.3.0        |
| Express/body-parser → qs                      | 6.15.1       | 6.16.0       |

The Nest 11 exact tuple is synchronized in the root manifest/lock, CI matrix
and conditions, release workflow, modern and no-pg packed consumer runners,
and README. Nest 10/12 and Schedule/Prisma control versions are preserved.

Jest stays at `29.7.0` and ts-jest at `29.4.9`: the coverage loader accepts
`js-yaml ^3.13.1`, and the fixed `3.15.2` is in that range. A Jest major change
is not needed to close the reported paths. Compatible updates also refresh
Babel helpers and Browserslist data dependencies. No overrides or new direct
production dependencies are introduced. The prior Nest/Jest exception is
closed by the post-update online audit.

Reproduction commands:

```bash
npm install --save-dev --save-exact @nestjs/common@11.2.3 @nestjs/core@11.2.3 @nestjs/platform-express@11.2.3 @nestjs/testing@11.2.3 --strict-peer-deps --no-audit --no-fund
npm update @babel/core browserslist js-yaml body-parser qs --strict-peer-deps --no-audit --no-fund
npm ci --strict-peer-deps --no-audit --no-fund
npm audit --json
npm audit --omit=dev --json
```

## Validation and boundaries

- Node `24.11.1`, npm `11.6.2`; clean strict-peer `npm ci` passed (645 packages).
- `npm run test:cov -- --runInBand`: 10 suites / 194 tests passed; statements
  92.08%, branches 83.29%, functions 96.64%, lines 92.92%.
- Lint, build typecheck, clean/build, compatibility policy, and workflow policy
  passed; the release workflow retains 19 immutable action references.
- Prisma `7.10.0` generate and PostgreSQL 16 E2E: 1 suite / 38 tests passed.
  The loopback-only disposable container `outbox-m22bc-pg-20260905` was created
  by this task; inherited `DATABASE_URL` was explicitly replaced.
- All five final strict packed consumers passed against the same tarball:
  no-pg exports; Nest `11.2.3` / Prisma `7.10.0`; Nest `12.0.1` / Schedule
  `12.0.1` / Prisma `7.10.0`; Nest `10.4.22` / Prisma `5.22.0`; and Nest
  `10.4.22` / Prisma `6.19.3`. Database consumers passed generate, typecheck,
  build, and real PostgreSQL smoke; the no-pg consumer passed typecheck and
  root/types/two SQL exports checks.
- The [verified packed artifact metadata](2026-09-05-out-m22bc-audit/packed-artifact.json)
  contains 134 files, 69,779 bytes, SHA-256
  `ce3432fe4878440dcb7810f747b657053073adf6e8e7cd3b0357cf8e64e3d157`, and SRI
  `sha512-cVGOixdzjSbQHOM/108Uo/V0zHeVPUowZrSZmitst4A5ZAzWluTyLkG+MC6eO07eQmjGI0eL7PDsKruHXw6Hww==`.
  This is a local validation candidate from the uncommitted tree, not a
  published release. Consumers used both `OUTBOX_TGZ` and
  `OUTBOX_TGZ_METADATA` to verify exactly those bytes.
- Changed manifest/README/CHANGELOG and the new report pass Prettier; both
  changed consumer scripts pass `node --check`, both workflows parse as YAML,
  raw audit hashes and local report links verify, and `git diff --check`
  passes. Historical documents were not broadly reformatted.

The fetched remote main remains `873f95b`, and npm latest remains `0.2.1` at
that commit. The requested prerequisites exist in local `main`, 29 commits
ahead. This task therefore branches from local `5319d79` to preserve the user's
completed maintenance work. No shared issue claim, push, PR, or release was
performed. The remote Node 22/24 CI matrix remains pending publication of these
local changes; local results do not claim a remote run.
