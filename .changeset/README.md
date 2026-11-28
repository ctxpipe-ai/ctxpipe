# Changesets

Every PR carries a changeset. Run `pnpm changeset` (or `pnpm changeset add --empty`).

## What to include in a changeset

CI runs `changeset status` on pull requests and fails when a versionable workspace package changed without a changeset. It does **not** check which package names appear in the changeset — that is up to reviewers and authors.

| You changed | Usually include in the changeset |
|-------------|----------------------------------|
| App code or Docker/deploy behavior (`apps/*`) | `@ctxpipe/aws-cdk` (patch or minor) so self-hosters get a new npm release with updated service image pins |
| Publishable package code (`packages/*`) | The package you changed (`ctxpipe` CLI or `@ctxpipe/aws-cdk`) |
| Both | One changeset can list multiple packages |

Use an **empty** changeset (only the two `---` lines, no text) for a change that an operator does not see or act on: CI, workflows, scripts, tests, types, telemetry, internal refactors, agent instructions, and docs. Do not use an empty changeset for an operator-visible change.

App packages (`@ctxpipe/backend`, `@ctxpipe/ui`, etc.) may appear in the changeset picker — **do not select them**. Apps are not published to npm; for app-only work, include only **`@ctxpipe/aws-cdk`** in the changeset.

## Kind

A changeset that names a package starts its summary with a kind tag. The release notes list the changes in three groups by kind.

| Tag | Use it for |
|-----|------------|
| `feature: ` | A new capability: a new connector, prop, page, tool, or command |
| `improvement: ` | A change that makes an existing capability better: speed, quality, text, layout, or a dependency update |
| `fix: ` | A correction of a defect: something that failed or gave a wrong result |

Add `!` before the colon for a breaking change, for example `fix!: `. A breaking change needs an action from the operator or the user. A major bump is also breaking. With `pnpm changeset`, type the tag at the start of the summary prompt. An empty changeset has no kind. The changeset guard fails for a changeset that names a package and has no kind ([ADR-020](../.ai/memory/decisions/ADR-020-changeset-ci-guard-policy.md), item 7).

Example:

```md
---
"@ctxpipe/aws-cdk": patch
---

fix: The sandbox host starts again after a reboot.
```

## Release flow

1. Merge a PR that includes one or more `.changeset/*.md` files.
2. The [Deploy workflow](../.github/workflows/deploy.yaml) runs `changesets/action`, which opens or updates a **chore(release): version packages** PR (version bumps + changelog updates).
3. Review and merge that version PR; the same workflow then publishes changed publishable packages to npm.

## Snapshot prerelease (manual)

To publish pending changesets to npm **without** cutting a stable release or consuming changesets on `main`:

1. Open **Actions → Deploy → Run workflow** in GitHub.
2. Choose the git ref (default `main`) and an npm dist-tag (`next`, `canary`, or `beta`). The workflow stamps `@ctxpipe/aws-cdk` with the checked-out git SHA as the service image tag.
3. For PR snapshots, make sure the PR image build has completed for that SHA; PR images are also published under the raw git SHA tag.

Only packages listed in pending changesets are published as snapshots under that dist-tag (for example `npm i @ctxpipe/aws-cdk@next`). Packages without a pending changeset are skipped. The stable release flow is unchanged.

See [ADR-020](../.ai/memory/decisions/ADR-020-changeset-ci-guard-policy.md) for the CI policy rationale.
