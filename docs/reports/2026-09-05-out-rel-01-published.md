# OUT-REL-01 — v0.3.0 publication evidence

- Date: 2026-09-05 (Asia/Seoul).
- Current state: **DONE — npm 0.3.0 and GitHub Release published.**
- [GitHub Release v0.3.0](https://github.com/nestarc/outbox/releases/tag/v0.3.0).
- Both tag workflow attempts concluded with failure; final verification and
  GitHub Release creation used the documented recovery below. No all-green
  tag workflow run is claimed.
- Release commit: `0e94c8df97bebb5cd85ee119a7608209a0c9e61b`.
- Annotated tag object: `b91415436ab440f3458247f8d96f87d6e8213a79`;
  peeled `v0.3.0` points to the release commit.
- [Release run 33936720398](https://github.com/nestarc/outbox/actions/runs/33936720398).

## Authorization and protected source

The user requested the GitHub Release and explicitly selected `ksyq12` as
the required npm deployment reviewer. Environment `npm` now has that reviewer,
`can_admins_bypass: false`, and exactly one custom deployment policy allowing
tags matching `v*.*.*`. Self-review is permitted because the selected maintainer
also initiates the tag workflow. Approval uses the designated reviewer endpoint,
not an administrator bypass.

Main ruleset `22309658` requires a PR and all eight CI contexts, blocks force
pushes and deletion, and has no bypass actors. Tag ruleset `22309659` blocks
updates/deletion of version tags and has no bypass actors. The release workflow
also verifies the exact manifest version and tag commit's main ancestry.

PR #18 merged the maintenance changes; PR #19 finalized the CHANGELOG date.
[Main CI 33936492784](https://github.com/nestarc/outbox/actions/runs/33936492784)
passed for the exact release commit before tag creation. All eight mandatory
jobs and the optional Node 26 canary succeeded. No tag was moved or force-pushed.

## Exact published artifact

The release's Node 22 job packed once after its source gates; Node 24 and the
publish job consumed the downloaded artifact. Local re-verification bound it
to `refs/tags/v0.3.0`, the protected release commit, and `release.yml`.

```text
Package: @nestarc/outbox@0.3.0
Files: 134; packed: 71,705 bytes; unpacked: 325,468 bytes
SHA-256: 56856c21d48199ced25ac7e79899294a0e9ba32fdd75a36bcdb889c33a6dc30c
SRI: sha512-rbPiDgQCNVtQifVf01we+vREYDDwccpezc5cSlaoa8VeIW3NxmGWrMe8ccwQRex/pF2MxlFW4K645SDbN27evQ==
```

Before deployment approval, the complete Node 22 and Node 24 verification jobs
passed, including 212 unit tests, critical coverage, 38 PostgreSQL E2E tests,
strict Nest 10/11/12 and Prisma 5/6/7 consumers, and README/no-optional-pg gates.
The public registry's 0.3.0 integrity matches this exact artifact.

## First publication and registry visibility failure

Attempt 1 published successfully at approximately `2026-09-05T01:44:35Z`.
The publish log records a signed GitHub Actions provenance statement and
[transparency log entry 2719081218](https://search.sigstore.dev/?logIndex=2719081218).
The subsequent isolated install at `01:44:52Z` failed with `ETARGET`, reporting
that 0.3.0 was not yet found. A fresh registry query immediately afterward
returned 0.3.0, its matching SRI and publish/SLSA attestations. The observations
are consistent with registry propagation delay; no verifier check was disabled.

The GitHub Release job correctly remained blocked after that failed check.
A full rerun of the same immutable tag was started to verify registry
idempotency and finish signature/provenance verification. Rerun the whole
workflow for this recovery: attempt-scoped artifact names require the producer
job to run too; rerunning only downstream jobs cannot reuse an earlier attempt's
artifact name.

Decoded public publish and SLSA v1 subjects match the tarball's SHA-512. The
SLSA statement names repository `https://github.com/nestarc/outbox`, tag
`refs/tags/v0.3.0`, commit `0e94c8df97bebb5cd85ee119a7608209a0c9e61b`, workflow
`.github/workflows/release.yml`, and attempt 1's invocation. Decoding alone is
not cryptographic verification; the recovery below also performed the npm
signature verification before checking the statements.

## Immutable-tag rerun and verified recovery

Attempt 2 rebuilt the same SHA-256/SRI and passed both source/consumer jobs.
Publish job `101228123464` reported identical bytes at `01:53:58Z` and skipped
the `Publish` step. The isolated install and `npm audit signatures` step in
job `101228243910` succeeded. Its following registry assertion failed because
npm 12.0.2 returns `npm view SPEC dist --json` as a singleton array, while the
verifier expected npm 11's object. The captured real response demonstrates
that the correct integrity was present; `dist.integrity` on the array was
undefined. The automated GitHub Release job again remained skipped.

The recovery normalizes either an object/scalar or a single-element array,
rejecting empty/multiple results and malformed JSON. Workflow policy regression
checks cover these cases. All digest, source, signature and attestation checks
remain active. The fix only changes repository release tooling; it does not
change the published package, tag, source commit, or signed statements.

Using Node **24.15.0** and npm **12.0.2**, a fresh isolated install and
`npm audit signatures --json --include-attestations` succeeded: `invalid: []`,
`missing: []`, and a verified `@nestarc/outbox@0.3.0` entry with publish/SLSA
bundles. The corrected verifier then passed exact artifact integrity, registry
integrity, both SHA-512 subjects, repository, tag, commit and workflow checks.
The registry guard also passed with identical-byte skip. The signed audit
bundle and successful recovery log are retained alongside the failed run
snapshots; decoding the earlier public statements was not used as a substitute.

After these checks, `gh release create v0.3.0 --verify-tag` created the public,
non-prerelease GitHub Release from the exact versioned CHANGELOG section.
This was an explicitly requested release completed by recovery, not a successful
automated `github-release` job. The immutable tag still points to `0e94c8d`.
A subsequent full rerun at that old tag would still execute its old parser;
future releases must include this tooling fix. Do not move the existing tag.

Local verification of the fix: initial regression test failed before the
parser existed; final workflow policy (20 immutable references), ESLint,
formatting and diff checks passed. The evidence/fix PR must pass the eight
protected-main CI contexts before merge.

## Retained evidence and remaining scope

The [evidence directory](2026-09-05-out-rel-01-published/) retains applied
environment/tag policies, active rulesets, exact main CI, artifact metadata,
registry integrity/signatures and decoded public statements. Earlier local and
branch preflight results remain in the preparation report.

The existing OUT-M22B development-only Prisma exception is unchanged, including
its 2026-10-04 expiry; production dependency audit is zero. Exactly-once/FIFO and
Jobs/TEN-ECO-NEXT integration are not claimed by this release. Existing 0.1/0.2
applications must follow the shipped 0.3.0 migration instructions.
