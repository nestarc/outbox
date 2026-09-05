# OUT-REL-01 — 0.3.0 release preparation and evidence

- Date/owner: 2026-09-05 (Asia/Seoul), Codex.
- Status: **BLOCKED — publication has not occurred.**
- Start: clean local `main@c14e71ecbfec90601c9e6ad96f8c656ae59c1942`.
- Branch: `codex/out-rel-01-release-0-3-0`, created from fetched `origin/main`
  and fast-forwarded to local main to preserve all 32 unpublished prerequisite
  commits. The earlier plan-only PR was never merged remotely; this candidate
  includes the accumulated maintenance work and requires review as a whole.
- Public baseline remains `origin/main` and `v0.2.1^{}` at
  `873f95bd86682d4b9515d743efbcfc093a88f450`; npm latest is `0.2.1` with the
  same gitHead. No existing tag or registry version was changed.

## Version and migration decision

The first local version assertion failed: `0.2.1 !== 0.3.0`. The package and
lockfile now declare **0.3.0**, the pre-1.0 minor selected by ADRs 0001–0008.
The required schema migration, readonly callback types, structured admin
mutation results, async registration changes, tenant null rejection, Node 22
floor, and export-map restrictions make a 0.2.x patch inappropriate.

README now provides a single ordered upgrade checklist and CHANGELOG contains
a versioned `0.3.0` entry marked **Unreleased** until publication. Operators
must drain old pollers before migration and may not mix unfenced 0.2.x workers
with the new runtime. At-least-once delivery and the existing no-FIFO contract
remain unchanged.

## Repository controls

The sandbox initially reported failed GitHub authentication. Retrying the
read-only checks with network/keychain access confirmed valid `ksyq12` admin
credentials; the previous invalid-token diagnosis is no longer current.

The before-state had no rulesets, no main branch protection, and an unrestricted
`npm` environment. The following rulesets are now active:

- [Protected main](https://github.com/nestarc/outbox/rules/22309658): require a
  PR, resolve review threads, require all eight CI checks from GitHub Actions
  with an up-to-date base, and block deletion and force pushes. There are no
  bypass actors. The only repository collaborator is its owner, so this rule
  does not require a second approving collaborator; it still requires the PR
  and every mandatory CI lane.
- [Immutable release tags](https://github.com/nestarc/outbox/rules/22309659):
  block updates and deletion of `v*.*.*` tags, with no bypass actors. The
  release workflow separately enforces matching version and main ancestry
  before npm publication.

The required CI contexts are lint/typecheck, six Node 22/24 × Nest/Prisma
matrix cells, and package dry-run. Node 26 remains an allowed-failure canary.
The request and returned effective settings follow GitHub's
[ruleset API](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset).
Raw before/after evidence is stored in [the evidence directory](2026-09-05-out-rel-01/).

The `npm` environment still needs its required reviewer selection, admin
bypass disabled, and a tag-only deployment policy. The reviewer question is
pending. The npm package access page redirects to sign-in, so Trusted Publisher
(`nestarc/outbox`, `release.yml`, environment `npm`) cannot yet be confirmed.
No environment approval or actual npm publication was attempted.

## Local verification

Host: Node `24.11.1`, npm `11.6.2`; clean strict `npm ci` installed 645 packages.
The dedicated `outbox-out-rel-01-20260905` compose project runs PostgreSQL 16
on the previously unused port 5433. Tests use only its disposable
`127.0.0.1:5433/outbox_test` database. The owned compose project was stopped
and removed after every local database lane passed.

- Clean, lint, build typecheck and build: PASS.
- Unit/critical coverage: **10 suites / 212 tests PASS**.
- Real PostgreSQL E2E: **1 suite / 38 tests PASS**, including P0 concurrency,
  stale claims, heartbeat/process-loss recovery, shutdown and historical upgrades.
- Compatibility and workflow policy: PASS; 20 immutable release action refs.
- Online production audit: **0**. Full audit: **4 high dev-only** Prisma nodes;
  existing OUT-M22B exception remains owned by maintainers and expires
  2026-10-04. No exception was extended.
- Same-tarball strict packed consumers: **PASS** for README examples with and
  without `pg`, no-`pg` package exports, Nest 11.2.3 and 12.0.1 with Prisma
  7.10.0, and Nest 10.4.22 with Prisma 5.22.0 and 6.19.3. Each database lane
  completed install/generate/typecheck/build and PostgreSQL smoke.
- Exact artifact re-verification, registry absent-version check and
  `npm publish package.tgz --ignore-scripts --access public --dry-run`: **PASS**.

A local validation candidate was packed once after the manifest and README
changes. Every local consumer uses this exact archive and its metadata:

```text
Version: 0.3.0
Files: 134; packed: 71,705 bytes; unpacked: 325,468 bytes
SHA-256: 56856c21d48199ced25ac7e79899294a0e9ba32fdd75a36bcdb889c33a6dc30c
SRI: sha512-rbPiDgQCNVtQifVf01we+vREYDDwccpezc5cSlaoa8VeIW3NxmGWrMe8ccwQRex/pF2MxlFW4K645SDbN27evQ==
```

This is **dirty-tree local validation evidence**, not a publishable protected
release artifact. The metadata's source commit identifies the starting HEAD,
not the uncommitted version/README edits. A final release workflow must pack
again exactly once from the committed, reviewed release ref and use its own
digest throughout verification, publication and attestation.

## Remote preflight and corrected CI defects

[Draft PR #18](https://github.com/nestarc/outbox/pull/18) contains the full
maintenance candidate. The initial
[CI run](https://github.com/nestarc/outbox/actions/runs/33933027009) caught two
previously unexecuted matrix defects:

- Nest 12 and Prisma 6 lanes failed the existing exact-version assertion:
  a second `npm install --no-save` for the adapter reset the first installed
  tuple to manifest defaults (`@nestjs/common@11.2.3`). CI now includes the
  adapter argument in the same install as the complete Nest/Prisma tuple.
- The Prisma 5 lane passed its 212 unit tests but could not generate the E2E
  client because the legacy schema contained no models. It now includes an
  unused generation-only probe model, as the packed Prisma 5 fixture already
  does. No production table or package runtime code changes.

The [second CI run](https://github.com/nestarc/outbox/actions/runs/33933282631)
passed the corrected legacy and Nest 12 lanes, then exposed one cross-step
artifact lifetime defect. A library `packArtifact()` call wrote its temporary
consumer paths into `GITHUB_ENV`; cleanup deleted them, so the next README
consumer failed with `ENOENT`. Only the release CLI now exports workflow-owned
artifact paths. Library calls remain local to the consumer. A local real-pack
regression verified an unchanged sentinel environment file after library pack,
valid CLI-exported paths, successful artifact verification, and identical bytes
(SHA-256 unchanged). Existing consecutive CI consumers exercise the regression.

These are release-gate fixes, not waived CI failures. The existing tuple
assertions and real PostgreSQL E2E remain mandatory. The initial manual
[release dry-run](https://github.com/nestarc/outbox/actions/runs/33933035863)
uses only contents-read jobs; real publish jobs cannot execute on dispatch.
The first manual dry-run succeeded. Updated remote results will be recorded
after the corrected candidate runs.

## Remaining release sequence

1. Complete remote CI/manual dry-run against the committed candidate.
2. Complete the npm environment policy and confirm Trusted Publisher settings;
   retain the authenticated evidence before closing OUT-M12.
3. Review and merge the accumulated prerequisites and 0.3.0 preparation through
   protected main. Confirm the final CHANGELOG date and successful required CI.
4. Create the immutable `v0.3.0` tag on that protected release commit. Let the
   release workflow build and verify its own exact artifact; the designated
   environment reviewer must approve the pending deployment.
5. Verify registry integrity, npm signatures/provenance and GitHub Release.
   Rerun the same immutable tag workflow and verify identical-byte skip, then
   record the remote artifact digest and close OUT-M21 and OUT-REL-01.

Jobs publishing and TEN-ECO-NEXT remain downstream work, not release blockers.
