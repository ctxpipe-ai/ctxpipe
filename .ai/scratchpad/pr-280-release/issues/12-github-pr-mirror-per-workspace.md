# Mirror merged GitHub pull requests into every Workspace that links the repository

Status: done
Priority: P1
Owner: unassigned
Blocked by: none
Created: 2026-10-02
Updated: 2026-10-03

## Context

Merged-PR mirroring still picks its target the pre-Workspace way (`models/github-pr-mirror-target.ts`):
- the repository another connector (Linear, Notion, Slack) binds; otherwise
- a repository named `ctxpipe-context`.

The mirror then only lands if that repository happens to be a Workspace's repository; otherwise it fails with "Connector target has no Workspace". Ledger row 15 in [main-intent-carry.md](../main-intent-carry.md).

User decision (2026-10-02): option A. Merged pull requests of a repository are mirrored into **every Workspace that links it** as a linked repository. No setup.

## Goal

Linking a GitHub repository to a Workspace is enough for its merged pull requests to appear under `github/` in that Workspace's repository.

## Acceptance criteria

- [x] Target resolution lists the Workspaces whose linked repositories include the PR's repository. There is no connector binding and no name heuristic; `isCtxpipeContextRepositoryName` and the context-repo candidate code are deleted.
- [x] A merged PR in a repository linked to two Workspaces is mirrored into both (one typed mirror job per Workspace); a repository linked to none mirrors nowhere and logs nothing as an error.
- [x] Backfill (up to 200 most recently updated merged PRs) runs when a repository is linked to a Workspace, not when a connector is bound.
- [x] Unlinking stops new mirrors; existing mirrored files stay in git.
- [x] Native contract test against a real git remote + MSW GitHub API covers: two Workspaces, unlink, and webhook replay.
- [x] Public docs (`connections/source-connectors/github.mdx`) updated.

## Plan

1. Replace `resolveGithubPrMirrorTarget` with a query over `workspace_linked_repositories` (matched by normalized URL) for the org.
2. Fan out `github-ensure-pr-mirror` / content workflows per Workspace (idempotency key includes the Workspace id).
3. Trigger backfill from the link workflow (`workspace-link-unlink`) instead of connector binding.
4. Delete the old target model and its tests; update docs.

## Delegation brief

Read first: `models/github-pr-mirror-target.ts`, `services/github/pull-request-mirror/*`, `openworkflow/workflows/github-ensure-pr-mirror.ts`, `github-sync-pull-request.ts`, `workspace-link-unlink.ts`, `routes/webhooks/github/github.ts`, ADR-047.

## Comments

- 2026-10-03 (claude): **landed.**
  - Target: `listGithubPrMirrorWorkspaceIds` (`models/github-pr-mirror.ts`) reads `workspace_linked_repositories` by normalized URL in the org. The webhook (`github-pr-mirror-events.ts`) starts one `github-sync-pull-request` per Workspace; idempotency key `github-pr:<workspaceId>:<gitUrl>:<number>:<updated_at>`. No Workspace → no run, nothing logged.
  - Git decides at write time: `captureGithubPrMirrorTarget` skips (`unlinked`) unless the captured Workspace tree still declares the repository; the write broker's scope check for `github` is the same declaration check, so an unlink commit stops mirrors even while the linked table lags hydrate. Mirror source = the linked repository's org `repositories` row (its GitHub connection reads the PRs). Files stay on unlink.
  - Backfill: `workspace-write-link-unlink` enqueues `github-backfill-pull-requests` after a link completes (`github-pr-backfill:<jobId>`): 200 newest-updated merged PRs, 20 per durable step, one commit. A declaration added by hand gets webhooks but no backfill (documented).
  - Policy is fixed (merged, not draft). Deleted: `prMirror` binding model + `connections.config.prMirror` schema, `github-pr-mirror-target.ts`, `source-scope` (`isCtxpipeContextRepositoryName`), `ensure`, `config-yaml`, `config-from-repo`, `github-ensure-pr-mirror` (+ startup sweep), `github-sync-content`, config-push activation, `/github/pull-request-mirror` API, GitHub install `contextRepository`, PR-mirror/`ctxpipe-context` candidates in the suggested connector target, `github/config.yaml` mirror-path exception.
  - Proof: `github-pr-mirror-native.contract.test.ts` (registered in the native write-jobs lane): real git remotes for two Workspaces + MSW GitHub API — link → backfill, replayed webhook → one run per Workspace, unlinked repo → no run, unlink → `unlinked` skip with old files kept, row dropped → no run.
  - Docs: GitHub connector guide, linked repositories, self-host GitHub; ADR-031 revised.
- 2026-10-03 (claude): **review fixes** (supersede the matching points above).
  - Backfill moved to hydrate: before it records a revision's linked repositories, a durable step enqueues a backfill for each GitHub repository not yet in the Workspace's table (key `github-pr-backfill:<workspaceId>:<gitUrl>`). Settings links and git-committed declarations are alike; the link workflow is back to unchanged. Existing links at deploy get webhooks but no backfill.
  - One workflow, `github-sync-pull-request`: webhook `numbers` or a backfill; one capture, one mirror child, one `runConnectorRepositoryIngestionWorkflow`. Reads use GitHub GraphQL — one request per page of 20 with files, reviews, comments and review threads inline; REST only for overflow or renames. Proof: `client.test.ts` counts requests per page; the contract's second case backfills 25 PRs (two page steps) and replays a stored page without calling GitHub.
  - Mirror source for GitHub is `{ provider: "github", gitUrl }`; no binding check. The broker scope check is the only unlink authority (capture no longer reads the pack), so a mirror captured just before an unlink fails at the broker instead of writing.
  - Connection: webhook installation connection; backfill uses the Workspace's. Missing → `no_source` warning.
  - Webhook enqueue failures answer 5xx; `issue_comment` on unmerged PRs is dropped before fan-out.
  - Retired `github-ensure-pr-mirror` / `github-sync-content` names complete queued runs as skipped (`github-pr-mirror-retired.ts`, delete one release later). Queued `github-sync-pull-request` runs with the old input fail schema validation — accepted.
  - The contract now reaches the linked table through real hydrate (A's git-declared link backfills on first hydrate; B via link → hydrate; unlink → hydrate removes the row).

## Resolution
