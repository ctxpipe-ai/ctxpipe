# ADR-020: Changeset CI guard policy

**Status:** Accepted | **Date:** 2026-05-20 | **Tags:** release, changesets, ci, aws-cdk

## Context

`@ctxpipe/aws-cdk` pins GHCR service image tags at build time. App changes on `main` publish new container images; self-hosters need a new **npm** release of `@ctxpipe/aws-cdk` to pick up those pins.

We previously enforced a custom CI rule: any PR touching `apps/*` had to include a changeset whose front matter named `@ctxpipe/aws-cdk`. That was correct but brittle (shell `grep`, separate branches for apps vs `packages/*`).

Changesets’ `status` command only fails when **versionable workspace packages** have file changes and **no** changeset files exist since the base branch. It cannot express “if `apps/*` changed, the changeset must list package X.”

## Decision

1. **CI scope:** On each PR (except release-bot PRs), run `pnpm changeset status --since=origin/<base>` after fetching the base branch. Changesets decides which workspace packages are versionable and changed; no custom `git diff` path filter. PRs that only touch non-package paths (e.g. repo-root docs, `.github`) pass; `examples/*` with `ignore`d packages typically pass without a changeset.

2. **Enforcement level:** CI requires **at least one** changeset when any versionable package has changes since the base branch, not a specific package name. With default `privatePackages.version` behavior, changes under `apps/*` mark the corresponding app workspace packages as changed, so `status` fails without a changeset.

3. **Engineer responsibility:** Authors and reviewers ensure the changeset lists the right package(s):
   - **App / deploy-affecting changes** → include `@ctxpipe/aws-cdk`.
   - **Changes under `packages/*`** → include the publishable package that changed.

4. **Release bot PRs:** Continue to skip the guard when the PR author is `github-actions[bot]` (version PRs consume changesets and do not add new ones).

5. **Every PR carries a changeset:** The guard fails only for a versionable package without a changeset. The author and the reviewer apply the wider rule: every PR has one changeset file.
   - A change that an operator does not see or act on gets an **empty** changeset (only the two `---` lines, no text). This covers CI, workflows, scripts, tests, types, telemetry, internal refactors, agent instructions, and docs.
   - An operator-visible change to a publishable package gets a patch or minor for that package (see item 3).

6. **No `privatePackages.version: false`:** Keeping the Changesets default avoids app-only PRs passing `status` with zero changesets.

## Consequences

- Simpler [changeset-guard workflow](../../.github/workflows/changeset-guard.yaml) and easier maintenance.
- **Risk accepted:** A changeset for the wrong package (or an empty changeset on an operator-visible change) can pass CI; release review must catch missing `@ctxpipe/aws-cdk` on app-only work.
- [`.changeset/README.md`](../../.changeset/README.md) documents author expectations.

## Alternatives Considered

- **Custom grep for `@ctxpipe/aws-cdk` on app changes** — Rejected for maintenance cost; strict coupling is not encoded in Changesets config.
- **`privatePackages.version: false` + always run `status`** — Rejected; app-only PRs would pass without any changeset.
- **Changeset bot only** — Rejected as sole gate; team wanted a hard CI failure on `main` PRs.

## Notes

- Example package `@ctxpipe/aws-cdk-self-host` remains in `.changeset/config.json` `ignore`.
- Stamp script dry-run in the guard workflow validates release tooling separately from Changesets.
