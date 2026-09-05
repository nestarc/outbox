# ADR 0007: Node LTS and NestJS 12 support policy

- Status: Accepted
- Date: 2026-09-03
- Task: `OUT-M14`
- Release target: next pre-1.0 minor (expected `0.3.0`)

## Context

The published `0.2.1` package declares Node `>=20`, NestJS 10/11, and
Schedule 4/5. As of this decision, the Node project lists Node 20 as EOL since
2026-03-24, Node 22 and 24 as LTS, and Node 26 as Current rather than LTS. The
official sources are the [Node release table](https://nodejs.org/en/about/previous-releases)
and [Node EOL guidance](https://nodejs.org/en/about/eol).

The current npm registry versions are NestJS `12.0.1` and
`@nestjs/schedule` `12.0.1`. Schedule 12 declares NestJS 11/12 peers. We use
the registry manifests for
[`@nestjs/core`](https://www.npmjs.com/package/@nestjs/core) and
[`@nestjs/schedule`](https://www.npmjs.com/package/@nestjs/schedule) rather
than assuming that Schedule's major continues to match its previous release
sequence.

## Evidence before the declaration change

With the published peer shape still present in the packed candidate, an exact
NestJS `12.0.1` + Schedule `12.0.1` strict install failed with `ERESOLVE`:

```text
Found: @nestjs/common@12.0.1
Could not resolve dependency:
peer @nestjs/common@"^10.0.0 || ^11.0.0" from @nestarc/outbox@0.2.1
```

No peer range was widened to bypass that result. The isolated runner then
staged an otherwise identical candidate manifest with Node `>=22`, NestJS
`^10 || ^11 || ^12`, and Schedule `^4 || ^5 || ^12`. Exact NestJS `12.0.1`,
Schedule `12.0.1`, Prisma `7.10.0`, and PostgreSQL 16 passed strict install,
Prisma generation, public typecheck, CommonJS build, shipped SQL resolution,
transactional emit, polling, tenant/global admin reads, and rollback smoke on
Node 24. The candidate tarball integrity was:

```text
sha512-BdmqpZoTfeL2lRyGiac66mvxdMKKSZX4WyJ0EyrAdvRRh0Fr6bqOoIvkSAkBrIfGrwz9K3fawlNQFoj/9bjGvQ==
```

The adopted manifest was then rerun without candidate rewriting on Node 22 and
24 with exact `@types/node` `22.20.1`. Both controls passed and produced the
same tarball integrity:

```text
sha512-yDyKkI6p2p/SbTy5DZiHIGRykxe1lPNbfFgfCY28vHN1M3x4wNsLRS9E8jyQY/7XF6NkrpNZSsyDSVBLRawomw==
```

Remote GitHub Actions remains required before release.

## Decision

1. Raise `engines.node` to `>=22.0.0`. Node 20 is not quarantined in a legacy
   CI lane; consumers that cannot upgrade remain on the `0.2.x` release line.
2. Treat Node 22 and 24 as required control/runtime lanes in CI and release
   verification.
3. Add NestJS `^12.0.0` to the common/core peer ranges and Schedule `^12.0.0`
   to the Schedule peer range. Preserve the already-proved NestJS 10/11 and
   Schedule 4/5 ranges.
4. Use exact NestJS `12.0.1` + Schedule `12.0.1` + Prisma `7.10.0` strict
   packed PostgreSQL consumers on Node 22 and 24 as the NestJS 12 gate.
5. Run Node 26 only as `continue-on-error` CI canary while it is pre-LTS. It is
   excluded from release jobs and the supported-runtime table.

## Semver and consequences

Raising the Node floor removes a previously declared runtime and is therefore
not a patch change. In this pre-1.0 package it ships with the already planned
next minor, expected `0.3.0`, with an explicit migration note. Adding NestJS
12 support is additive, but it ships in the same release so engines, peers,
README, CI, and release verification describe one policy.

This decision does not promise every untested combination inside the broad
peer-product matrix. Exact control tuples provide regression evidence; the
peer ranges state the install contract. Node 26 canary success alone cannot
promote support. A later compatibility-manifest task may centralize duplicated
version literals, but that refactor is outside `OUT-M14`.
