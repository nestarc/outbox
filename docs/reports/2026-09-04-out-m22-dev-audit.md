# OUT-M22 development dependency audit remediation

> 2026-09-05 follow-up: OUT-M22C is resolved; OUT-M22B remains blocked on a
> supported Prisma 7 fix. The complete online before/after audit is now
> available in the [OUT-M22B/C report](2026-09-05-out-m22bc-dev-audit.md).
> The results below are the historical 2026-09-04 snapshot.

- Date: 2026-09-04 (Asia/Seoul)
- Runtime package: `@nestarc/outbox@0.2.1`
- Scope: one compatible ESLint/tooling update group; no runtime dependency or
  Prisma compatibility change

## Gate and baseline

`npm audit --omit=dev --json` remains zero and is now a named
`audit:production` command required by CI and the release artifact-producing
job. Production audit failure is a hard gate.

The 2026-09-02 full-lock baseline contained ten dev/test/build findings: seven
high, one moderate, and two low. The dependency paths were split before any
update:

| Group             | Observed path                                                                                   | Runtime exposure                                         |
| ----------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Prisma CLI        | `prisma -> @prisma/config -> deepmerge-ts`; `prisma -> mysql2`                                  | Dev CLI only; Prisma is not a package runtime dependency |
| Jest/Babel        | `jest/ts-jest -> glob/minimatch/brace-expansion`; `ts-jest -> babel-plugin-istanbul -> js-yaml` | Test and coverage only                                   |
| ESLint            | `eslint` / TypeScript ESLint -> config/minimatch/brace-expansion/js-yaml                        | Lint only                                                |
| Nest test adapter | `@nestjs/platform-express -> express -> body-parser/qs`                                         | Dev test application only                                |

## Selected compatible update group

Only the lint group was modernized in this task:

- ESLint 8 and eslintrc were replaced with the supported ESLint 10 flat-config
  line;
- TypeScript ESLint 7 was replaced with the compatible 8.x line;
- `eslint-config-prettier` moved to 10.x, with direct `@eslint/js` and `globals`
  configuration dependencies;
- compatible lockfile refreshes moved legacy `brace-expansion` 1.1.13 to
  1.1.18, 2.0.3 to 2.1.4, and the ESLint path to 5.0.9.

The old and new configurations produced the same zero-error result over
`src/**/*.ts` and `test/**/*.ts`; unit tests and build also pass. No
`npm audit fix --force`, Prisma downgrade, runtime dependency, peer range, or
published package behavior was introduced.

An online audit response captured after the ESLint upgrade and before the final
compatible brace refresh reported seven remaining dev-only nodes (five high,
one moderate, one low), including the Prisma chain, the still-old brace node,
and the Nest test adapter. After the brace refresh, the installed tree contains
only advisory-fixed brace versions. Repeated full-lock npm audit requests then
failed to terminate in this host even though registry ping and production audit
succeeded; this limitation is recorded rather than treating an offline empty
result as evidence.

## Time-bounded dev-only exceptions

| Owner              | Path / severity                                              | Reason                                                                                                                                                                                                                  | Expiry and next task                                                            |
| ------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Outbox maintainers | Prisma CLI `@prisma/config/deepmerge-ts` and `mysql2` (high) | Exact Prisma 7.10.0 is a declared compatibility control. The audit auto-fix path must not silently downgrade/remove Prisma 7.                                                                                           | 2026-10-04 or next supported Prisma patch, whichever is earlier; `OUT-M22B`     |
| Outbox maintainers | Nest test adapter `body-parser` (low) and `qs` (moderate)    | The vulnerable versions are reachable only through the dev-only Nest/Express test server; the published package has no runtime dependency on them. Patch availability and exact Nest controls must be updated together. | 2026-10-04 or next exact Nest control refresh, whichever is earlier; `OUT-M22C` |

`js-yaml@3.14.2` remains in the Jest coverage tree but was not present as a
finding in the captured 2026-09-04 audit response. It remains part of
`OUT-M22C`'s Jest-major review so a future advisory cannot be mistaken for a
production exposure.

## Verification

- `npm run audit:production`: zero vulnerabilities.
- `npm run lint`: pass with ESLint 10 flat config.
- `npm test -- --runInBand`: 10 suites, 194 tests pass.
- `npm run build`: pass.
- `npm ls brace-expansion js-yaml --all`: brace versions are 1.1.18, 2.1.4,
  and 5.0.9; Jest's dev-only `js-yaml` is 3.14.2.
- Full online audit post-refresh: host-side npm audit termination remains
  unverified; CI must capture it when `OUT-M22B/C` is executed.
