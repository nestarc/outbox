# OUT-M12 release control evidence

- Captured: 2026-09-03 (Asia/Seoul)
- Repository: `nestarc/outbox`
- Scope: read-only before-state plus repository workflow controls

## Read-only before-state

The public GitHub API was queried before attempting any settings change.

| Control                        | Observed state                      |
| ------------------------------ | ----------------------------------- |
| Repository                     | public; default branch `main`       |
| Repository rulesets            | empty list (`[]`)                   |
| `npm` environment              | exists; `can_admins_bypass: true`   |
| `npm` protection rules         | empty list                          |
| `npm` deployment branch policy | `null`                              |
| Local GitHub CLI authorization | configured account token is invalid |

Commands used:

```bash
curl -L --max-redirs 5 -sS https://api.github.com/repos/nestarc/outbox
curl -L --max-redirs 5 -sS https://api.github.com/repos/nestarc/outbox/rulesets
curl -L --max-redirs 5 -sS https://api.github.com/repos/nestarc/outbox/environments/npm
gh auth status
```

No repository or environment setting was changed. Unauthenticated public API
access cannot create rulesets or configure environment reviewers, and the
available GitHub CLI credential cannot authorize those mutations.

## Required administrator follow-up

Before OUT-M12 can move from `EXTERNAL` to `DONE`, a repository administrator
must capture the authenticated before-state and apply all of these controls:

1. Protect `main` with an active ruleset that requires pull requests and the
   complete CI gate, blocks force pushes and deletion, and does not allow a
   release workflow bypass.
2. Protect release tags matching `v*.*.*` against update and deletion. The tag
   must be created only for a commit already reachable from protected `main`.
3. Configure the `npm` environment with required reviewer(s), disable admin
   bypass, and limit deployment to protected release refs.
4. Confirm npm Trusted Publishing still targets organization `nestarc`,
   repository `outbox`, workflow `release.yml`, and environment `npm`.
5. Re-run `npm run test:workflow-policy`, dispatch one manual dry-run, and
   retain screenshots/API JSON for both rulesets and the environment policy.

The repository workflow independently fails closed for a mismatched version,
non-tag real publish, or tag commit outside `main`, but those checks do not make
mutable Git refs immutable; the external rulesets remain mandatory.
