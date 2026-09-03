# OUT-M21 pack-once release artifact evidence

- Date: 2026-09-03 (Asia/Seoul)
- Local start ref: `7650295532c26a8da8a9eeb2f7a608371f686632`
- State: local implementation and PostgreSQL consumer proof complete; remote
  tag/publish proof blocked by `OUT-M12` repository/environment controls

## Artifact graph

The release workflow now has one artifact-producing edge. No downstream job
builds or packs the package again.

```text
verify tag/main/version
        |
        v
Node 22 source gates -- pack once --> package.tgz + metadata.json
        |                                  |
        |                   upload release-package-$SHA-$ATTEMPT
        |                                  |
        +-- exact Nest 11/12, Prisma 5/6/7 consumers
                                           |
                                           v
                         Node 24 exact-artifact consumer
                                /                    \
                    manual dry-run               tag publish
                                                      |
                                            registry SRI equality
                                                      |
                                      npm signature + provenance check
                                                      |
                                             GitHub Release
```

`scripts/test-workflow-policy.js` rejects a downstream `npm pack`, build, or
`prepublishOnly` command in the Node 24, manual, or npm publish jobs. It also
requires immutable upload/download action refs, explicit artifact verification,
the registry idempotency check, and the post-publish attestation gate.

## Artifact contract

`scripts/release-artifact.js` creates `package.tgz` and `metadata.json`. The
metadata binds the package name/version, packed and unpacked size, SHA-512 SRI,
SHA-256 digest, exact file list, repository, commit, ref, and workflow path.

The verifier extracts the tarball and permits only:

- `package.json`, `README.md`, and `LICENSE` at the package root;
- `dist/**`;
- `src/sql/**`.

It requires the package root, the manifest `main` and `types` targets,
`create-outbox-table.sql`, and `upgrade-0.1-to-0.2.sql`. Packed size is capped
at 512 KiB and unpacked size at 2 MiB. Every consumer accepts only a paired
`OUTBOX_TGZ` and `OUTBOX_TGZ_METADATA` and recomputes the digests before
installation.

Before publication, `registry-check` has three outcomes:

1. version absent: publish the exact tarball;
2. version present with identical SRI: idempotently skip publish;
3. version present with different SRI: fail.

After publication, npm CLI `audit signatures --json --include-attestations`
cryptographically verifies registry and provenance attestations. The local
verifier then requires both verified publish and SLSA provenance statements,
matches their SHA-512 subjects to `package.tgz`, and matches the provenance
repository, tag ref, source commit, and `.github/workflows/release.yml`.

## Local evidence

- First RED: workflow policy failed with `missing verify-published job`.
- Final workflow policy: 19 immutable action references, PASS.
- Pack/verify: 117 files, 55,692 packed bytes, 253,963 unpacked bytes,
  `sha512-yDyKkI6p2p/SbTy5DZiHIGRykxe1lPNbfFgfCY28vHN1M3x4wNsLRS9E8jyQY/7XF6NkrpNZSsyDSVBLRawomw==`,
  SHA-256 `3662e508d7eede5a2ef95e59f7e03668d0f2b746c231a6b1c7454c0723a38216`.
- The exact tarball above passed isolated PostgreSQL smoke with NestJS 11.2.1
  and 12.0.1, Prisma 5.22.0, 6.19.3, and 7.10.0.
- The public `0.2.1` registry SRI differs from the local candidate; the guard
  failed with exit 1 as required instead of treating the existing version as
  success.
- The public `0.2.1` tarball took the complementary identical-byte path and was
  idempotently skipped. Its actual npm 12 cryptographically verified publish
  and SLSA v1 provenance bundles passed the new subject digest, repository,
  `refs/tags/v0.2.1`, source commit, and workflow checks end to end.
- The actual npm 12 response uses `attestationBundles`, percent-encoded scoped
  package subjects, and hexadecimal SHA-512 digests; the repository-local
  parser fixture locks this response shape.

## Remote evidence still required

1. Complete `OUT-M12`: protected main/tag rules, npm environment restrictions,
   and Trusted Publisher settings.
2. Push the change and run manual dispatch; confirm artifact upload/download,
   Node 22/24 consumers, and tarball dry-run without publication.
3. For the next release tag, record the artifact digest, registry integrity,
   npm verified attestation subject/ref/commit/workflow, and the GitHub Release
   job that depended on that verification.
4. Rerun the immutable tag workflow and record the identical-byte idempotent
   skip. A moved tag or a different tarball must fail instead.
