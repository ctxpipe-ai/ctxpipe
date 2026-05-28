# Changesets

Run `pnpm changeset` when a PR changes code under `apps/` or `packages/`.

## What to include in a changeset

CI runs `changeset status` on pull requests and fails when a versionable workspace package changed without a changeset. It does **not** check which package names appear in the changeset — that is up to reviewers and authors.

| You changed | Usually include in the changeset |
|-------------|----------------------------------|
| App code or Docker/deploy behavior (`apps/*`) | `@ctxpipe/aws-cdk` (patch or minor) so self-hosters get a new npm release with updated service image pins |
| Publishable package code (`packages/*`) | The package you changed (`ctxpipe` CLI or `@ctxpipe/aws-cdk`) |
| Both | One changeset can list multiple packages |

Do not use `changeset add --empty` for real product changes.

App packages (`@ctxpipe/backend`, `@ctxpipe/ui`, etc.) may appear in the changeset picker — **do not select them**. Apps are not published to npm; for app-only work, include only **`@ctxpipe/aws-cdk`** in the changeset.

## Release flow

1. Merge a PR that includes one or more `.changeset/*.md` files.
2. The [Deploy workflow](../.github/workflows/deploy.yaml) runs `changesets/action`, which opens or updates a **chore(release): version packages** PR (version bumps + changelog updates).
3. Review and merge that version PR; the same workflow then publishes changed publishable packages to npm.

## Snapshot prerelease (manual)

To publish pending changesets to npm **without** cutting a stable release or consuming changesets on `main`:

1. Open **Actions → Deploy → Run workflow** in GitHub.
2. Choose the git ref (default `main`) and an npm dist-tag (`next`, `canary`, or `beta`).

Only packages listed in pending changesets are published as snapshots under that dist-tag (for example `npm i @ctxpipe/aws-cdk@next`). Packages without a pending changeset are skipped. The stable release flow is unchanged.

See [ADR-020](../.ai/memory/decisions/ADR-020-changeset-ci-guard-policy.md) for the CI policy rationale.
