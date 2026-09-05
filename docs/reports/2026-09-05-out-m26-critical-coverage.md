# OUT-M26 critical coverage contract

- Date: 2026-09-05 (Asia/Seoul)
- Start: local `main@16e9fc2be5e946dfdc7a10ff740f5c0880d37bcd`; branch `codex/out-m26-critical-coverage`.
- The fetched remote main and dereferenced `v0.2.1` remain `873f95b`; npm latest remains `0.2.1`. The 31 local prerequisite commits were preserved. No shared claim, commit, push, PR, release, or remote workflow dispatch was performed.
- Scope: test/config/workflow evidence only. Runtime, schema, peer dependencies, package version, and accumulated 0.3.0 migration decisions are unchanged.

## Baseline and gate

The first run passed all 194 unit tests and the previous global 80% gate, despite listener branch coverage below 80%. Adding file thresholds made the same tests fail. This is the first RED for OUT-M26; it is a missing regression gate, not a newly discovered runtime bug.

| File                          | Baseline branches |  Final branches | Required branches | Required statements / lines / functions |
| ----------------------------- | ----------------: | --------------: | ----------------: | --------------------------------------- |
| `src/outbox.poller.ts`        |   86.13% (87/101) | 91.08% (92/101) |               90% | 95% / 95% / 100%                        |
| `src/outbox.admin.service.ts` |    83.13% (69/83) |  97.59% (81/83) |               95% | 95% / 95% / 100%                        |
| `src/outbox.listener.ts`      |    78.26% (36/46) |  91.30% (42/46) |               90% | 95% / 95% / 95%                         |

The thresholds live in [jest.config.ts](../../jest.config.ts). Poller/listener keep a 90% branch floor for the defensive paths listed below; admin has a 95% floor. No Istanbul ignore directives or coverage collection exclusions were added. Jest subtracts explicitly gated files from its global bucket: the existing global 80% now applies independently to the remaining files. The aggregate report still shows all files (branches 88.04%, statements 94.81%, lines 95.37%, functions 97.20%).

The gate always runs the full unit project. `npm run test:cov` accepts only the optional `--runInBand` argument; use `npm test -- ...` for filtered debugging. PostgreSQL E2E remains a separate mandatory CI/release gate and is not merged into the unit percentage.

## Critical behavior inventory

These are review obligations as well as numeric gates. A change to a listed branch must preserve its semantic assertions; a high file percentage alone cannot prove correct SQL, ownership, or concurrency. Test names below are stable search anchors within the linked files.

| Contract                                                                                                                                          | Unit evidence                                                                                                                                                | Required real PostgreSQL evidence                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `PROCESSING → SENT/PENDING/FAILED` uses immutable id/token and discards zero-row CAS, suppressing success/failure hooks after lost ownership      | [poller tests](../../test/outbox.poller.spec.ts): claimed identity under callback mutation; stale terminal/retry CAS table; new no-handler FAILED CAS loss   | [E2E](../../test/e2e/outbox.e2e-spec.ts): stale owner completion cases; distinct two-poller claims; publisher terminal failure |
| Lease renewal is single-flight; dispatch completion waits for active renewal; failed/zero-row renewal discards completion                         | Poller: `renews the lease`, `discards completion`, `zero-row heartbeat`, new `waits for an in-flight heartbeat`                                              | E2E: `keeps a blocking publisher exclusively leased across two pollers`; `recovers an expired process-loss lease`              |
| Shutdown releases unstarted claims, tolerates zero-row release, waits for active work, and drops queued reruns                                    | Poller: shutdown suite, including new CAS rows 0/1 release cases                                                                                             | E2E: `releases a real PostgreSQL claim fetched after shutdown starts`                                                          |
| Retry due time is persisted; exhausted retries become FAILED; publisher rejection is normalized                                                   | Poller: retry timing/cap, final failure, new non-Error rejection                                                                                             | E2E: mixed backoff settings; publisher terminal state; crash-window redelivery after acceptance before SENT                    |
| Timer/manual/notification triggers coalesce; a transient DB failure does not poison later polling                                                 | Poller coordinator tests and listener notification burst                                                                                                     | E2E: real notification burst and polling fallback                                                                              |
| Admin source-state matrix returns applied/not_found/conflict/lost_claim; unknown outcomes fail closed; retry count and terminal fields follow CAS | [admin tests](../../test/outbox.admin.service.spec.ts): retry/markFailed outcome tables, new unknown outcome rejection, bulk partial failure                 | E2E: admin source-state matrix, active-poller completion race, concurrent lost_claim, 10,001-row retry                         |
| Tenant admin mutations and cursor reads bind the expected tenant and cannot widen scope                                                           | Admin tenant boundary tests and new filtered/scoped listPage cases; malformed cursor rejects before DB access                                                | E2E: tenant reads/mutations, tied-timestamp cursor pagination                                                                  |
| Initial client/connect/LISTEN failure falls back only when polling is enabled; wakeup-only failure is typed                                       | [listener tests](../../test/outbox.listener.spec.ts): initial failure table and polling-disabled error                                                       | E2E: notification loss fallback; existing packed examples separately prove optional-pg absence                                 |
| Reconnect error/end paths back off, close/detach old clients, fence stale callbacks, and do not reschedule after shutdown                         | Listener reconnect/backoff/stale tests; new cleanup/close non-Error failures; overlapping init/replacement; shutdown during connect/LISTEN/reconnect factory | E2E: `delivers through the current real PostgreSQL reconnect generation`; LISTEN readiness barrier                             |

New cases use public lifecycle/poll/admin methods, fake timers, and explicit promise barriers. No production code or private state is modified to increase coverage.

## Remaining uncovered branch inventory

Locations refer to the unchanged source at the start commit. Keep this list under review rather than forcing private methods into unreachable states for a percentage.

- Poller: constructor polling default (`98`); bounded shutdown timeout warning (`146`); non-Error background, heartbeat, and hook rejection normalization (`163`, `551`, `746`); redundant shutdown guard inside `pollOnce` (`224`); transport disappearing after constructor validation (`363`); invalid internal retry count and arithmetic overflow guards after persisted/options validation (`644`, `660`). The bounded shutdown timeout remains an explicit unit evidence gap.
- Admin: `getHealth()` default argument (`463`); rethrowing an already typed cursor error from inside the decoder (`566`). CAS result alternatives are covered.
- Listener: redundant shutdown guards at `connectOnce`/`reconnect` entry (`120`, `242`); actual optional module loader returning/missing `pg.Client` (`199`). Loader absence/presence has separate packed consumer evidence from OUT-M25; it is not counted as unit coverage here.

## Nest 12 primary-cell compatibility

Running the actual CI primary tuple exposed an existing harness failure: Nest 12.0.1 is ESM, while Jest 29 runs the source suite in a CommonJS VM. Nine suites failed before assertions (`Cannot use import statement outside a module`); converting imports alone still left `import.meta.url` unparsable. This prevented the existing primary coverage lane from producing evidence.

The shared unit/E2E Jest config now transforms only `@nestjs/` dependency JavaScript through [scripts/jest-esm-dependency.js](../../scripts/jest-esm-dependency.js), using the already installed TypeScript compiler. An AST transform preserves each real module's `import.meta.url` as its original file URL. TypeScript source still uses the existing ts-jest typechecking path. Other dependencies remain ignored, and package build/consumer behavior is unchanged. The transform preserves CommonJS default-import interop and invalidates its cache when transformer code, compiler version, source, path, or Jest options change. A direct transformer check verifies a filename containing spaces, untouched string literals, source-map content, and cache keys. The Nest 12 unit and real PostgreSQL suites exercise the transformed dependency graph.

## Artifact identity

[scripts/test-critical-coverage.js](../../scripts/test-critical-coverage.js) clears old coverage, invokes the full Jest unit coverage gate, propagates nonzero exits, and writes `coverage/metadata.json` only after success. It records:

- Actual checkout commit/tree, dirty status, and SHA-256 for relevant source/tests/scripts/config/lock/workflow inputs, including untracked inputs. A dirty local run is not represented as an immutable committed result. Input/HEAD changes during testing fail the runner.
- Actual Node/npm/platform/architecture and installed Nest common/core/schedule/testing, Prisma CLI/client/adapter, pg, Jest, ts-jest, and TypeScript versions. These are read from installed packages, not matrix labels or package ranges.
- GitHub workflow/event/ref/SHA/run id/attempt separately from checkout identity (including PR merge-checkout semantics).
- Exact command, timestamps, and SHA-256 of raw coverage, summary, LCOV, and Jest test results.

CI's primary Node 24/Nest 12/Prisma 7 artifact name includes commit, matrix tuple, and attempt. Release gates coverage on its locked Node 22 runtime before packing and uploads a separate artifact; installed exact versions are in metadata. Release coverage is captured before the later legacy runtime installation. Existing E2E and strict packed gates remain mandatory. Workflow policy assertions check this wiring.

## Validation

The two installed tuples, shared input digest, coverage counts, and raw report hashes are retained in [coverage-evidence.json](2026-09-05-out-m26-coverage-evidence.json). These are explicitly local dirty-tree results, not remote CI evidence.

- Clean `npm ci --strict-peer-deps --no-audit --no-fund`: 645 packages installed.
- Full unit coverage: 10 suites / 212 tests PASS on local Node 24.11.1, npm 11.6.2, Nest 11.2.3, Schedule 5.0.1, Prisma 7.10.0.
- Primary tuple control: Node 24.11.1 / Nest 12.0.1 / Schedule 12.0.1 / Prisma 7.10.0 also passes all 212 unit tests and the same thresholds; installed-version assertions and all four metadata report hashes match. Dependencies are restored afterward with strict `npm ci`.
- Gate negative control: temporarily require poller branch 100%; all 212 tests still pass but the runner exits 1 and leaves no successful metadata. The real threshold is restored afterward.
- PostgreSQL 16 E2E: 1 suite / 38 tests PASS on both Nest 11 and Nest 12 using only disposable compose project `outbox-out-m26-20260905` on loopback port 5433.
- Lint, build typecheck/build, compatibility policy, workflow policy (20 immutable release action references), scoped formatting, and `git diff --check`: PASS.

Remote Node 22/24 Actions and artifact upload/download are unexecuted until review/push. This task does not claim remote runs or a release. Packed runtime behavior is unchanged, so the complete packed matrix is not rerun here; OUT-M25 remains its prior evidence. The known Prisma CLI dev-only exception remains owned by OUT-M22B and is not changed by a coverage gate.
