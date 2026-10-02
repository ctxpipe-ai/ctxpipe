# Mirror merged GitHub pull requests into every Workspace that links the repository

Status: ready
Priority: P1
Owner: unassigned
Blocked by: none
Created: 2026-10-02
Updated: 2026-10-02

## Context

Merged-PR mirroring still picks its target the pre-Workspace way (`models/github-pr-mirror-target.ts`):
- the repository another connector (Linear, Notion, Slack) binds; otherwise
- a repository named `ctxpipe-context`.

The mirror then only lands if that repository happens to be a Workspace's repository; otherwise it fails with "Connector target has no Workspace". Ledger row 15 in [main-intent-carry.md](../main-intent-carry.md).

User decision (2026-10-02): option A. Merged pull requests of a repository are mirrored into **every Workspace that links it** as a linked repository. No setup.

## Goal

Linking a GitHub repository to a Workspace is enough for its merged pull requests to appear under `github/` in that Workspace's repository.

## Acceptance criteria

- [ ] Target resolution lists the Workspaces whose linked repositories include the PR's repository. There is no connector binding and no name heuristic; `isCtxpipeContextRepositoryName` and the context-repo candidate code are deleted.
- [ ] A merged PR in a repository linked to two Workspaces is mirrored into both (one typed mirror job per Workspace); a repository linked to none mirrors nowhere and logs nothing as an error.
- [ ] Backfill (up to 200 most recently updated merged PRs) runs when a repository is linked to a Workspace, not when a connector is bound.
- [ ] Unlinking stops new mirrors; existing mirrored files stay in git.
- [ ] Native contract test against a real git remote + MSW GitHub API covers: two Workspaces, unlink, and webhook replay.
- [ ] Public docs (`connections/source-connectors/github.mdx`) updated.

## Plan

1. Replace `resolveGithubPrMirrorTarget` with a query over `workspace_linked_repositories` (matched by normalized URL) for the org.
2. Fan out `github-ensure-pr-mirror` / content workflows per Workspace (idempotency key includes the Workspace id).
3. Trigger backfill from the link workflow (`workspace-link-unlink`) instead of connector binding.
4. Delete the old target model and its tests; update docs.

## Delegation brief

Read first: `models/github-pr-mirror-target.ts`, `services/github/pull-request-mirror/*`, `openworkflow/workflows/github-ensure-pr-mirror.ts`, `github-sync-pull-request.ts`, `workspace-link-unlink.ts`, `routes/webhooks/github/github.ts`, ADR-047.

## Comments

## Resolution
