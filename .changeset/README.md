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

See [ADR-020](../.ai/memory/decisions/ADR-020-changeset-ci-guard-policy.md) for the CI policy rationale.

## CLI prerelease (beta)

Use this when you want testers to run `npx ctxpipe@beta …` without publishing from a laptop.

1. Enter prerelease mode and add a changeset as usual:
   ```bash
   pnpm changeset pre enter beta
   pnpm changeset
   pnpm changeset version
   ```
2. Commit and push the version bump (for example `0.2.0-beta.0` in `packages/cli/package.json`).
3. In [npm → ctxpipe → Trusted Publisher](https://www.npmjs.com/package/ctxpipe/access), add a publisher for repo **`ctxpipe-ai/ctxpipe`**, workflow file **`release-cli-prerelease.yaml`**, environment **(none)** — same as `deploy.yaml`, but with the new workflow filename.
4. In GitHub → **Actions → Release CLI (prerelease) → Run workflow**, pick the branch you pushed and set dist-tag **`beta`** (default).

The workflow builds and tests `ctxpipe`, then runs `npm publish --tag <dist-tag>`. It refuses `latest` and refuses stable semver (no `-` in the version). Stable releases still go through the main [Deploy workflow](../.github/workflows/deploy.yaml) on `main`.

To exit prerelease mode after shipping stable: `pnpm changeset pre exit` (usually on a follow-up PR).
