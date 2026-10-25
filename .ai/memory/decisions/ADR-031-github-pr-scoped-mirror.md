# ADR-031: GitHub pull-request scoped mirror

**Status:** Accepted (revised 2026-10-03, 2026-10-13, 2026-10-25) (sync repository and scope file superseded by [ADR-050](ADR-050-workspace-sources-config-file.md)) | **Date:** 2026-09-16 | **Tags:** connectors, github, git, graph, ingestion, workspaces

## Revision (2026-10-25): issues follow linked repositories

- **Scope:** the issues of a linked repository, open and closed, are mirrored
  into every Workspace that links it, the same as closed pull requests. There
  is no setting; the link is the scope.
- **Files:** one file per issue at `github/issues/<owner>/<repo>/<number>.md`.
  GitHub never reuses an issue number. The file holds the description, the
  labels, the assignees, the state and the comments. The URLs of the pull
  requests that closed the issue are in the front matter and in the body.
  Hydrate reads the file as an `Issue`. A GitHub issue or pull request URL in
  a mirror file links to the mirrored unit of that number (`ghn:` key);
  GitHub numbers issues and pull requests from one sequence.
- **Workflow:** `github-sync-issue` is a separate workflow next to
  `github-sync-pull-request`. It mirrors one webhook issue, or backfills the
  200 most recently updated issues: one GraphQL request per page of 50 with
  the first 100 comments of each issue inline, one durable step per page,
  and one commit. An issue that GitHub no longer has (deleted or moved) is
  removed from the Workspace.
- **Triggers:** the `issues` event and the `issue_comment` event on an issue
  (not on a pull request) fan out to the linked Workspaces as the pull
  request events do. Hydrate starts the issue backfill of a new link in the
  same step as the pull request backfill.
- **Permission:** the App needs **Issues: Read-only** and the **Issues**
  event. The issue credential asks only for that permission. When the owner
  of an installation has not accepted it, GitHub refuses the credential and
  the issue mirror skips with a warning; the pull request mirror is a
  separate workflow and is not affected. Links that existed before this
  release, and installations that accept the permission later, get issues as
  they change, with no backfill.

## Revision (2026-10-13): closed pull requests and RESOLVES

- **Policy:** each closed, non-draft pull request is mirrored: merged, or
  closed without a merge. Open pull requests are not. Every source reports a
  merged pull request as `closed`, so the policy reads only the state and the
  draft flag. The webhook, the `issue_comment` path, and the backfill use the
  same path as before. The backfill page asks GitHub for
  `states: [MERGED, CLOSED]`, so the 200 most recently updated closed pull
  requests share the existing page walk and cap. A page of 20 is still one
  GraphQL request; a pull request closed without a merge adds a REST read
  only when it overflows a nested list or has a rename, as a merged one does.
- **Graph:** a pull request closed without a merge keeps its node,
  `TARGETS Repository`, and `REFERENCES Issue`. It has no change edges and no
  `File` objects, because it changed nothing on the base branch. A merged pull
  request has `RESOLVES Issue` in place of `REFERENCES Issue` for each issue
  it closes ([ADR-033](ADR-033-graph-ontology-v2.md)). A revert pull request
  only references issues.
- **Known gap:** a pull request that is reopened after a close keeps its
  mirrored file until it closes again; open pull requests are not written.

## Revision (2026-10-03): mirror follows linked repositories

Workspaces replaced the context repository, so the target and scope below
(decisions 1–2, the `ctxpipe-context` setup step, the startup sweep and the
connector-preselect consequence) are superseded:

- **Target:** merged pull requests of a repository are mirrored into **every
  Workspace that links it** as a linked repository. Webhooks find those
  Workspaces in `workspace_linked_repositories` (normalized URL, org-scoped)
  and start one `github-sync-pull-request` run per Workspace with the
  webhook's installation connection; the idempotency key includes the
  Workspace id, so a replayed delivery is one run per Workspace. A failed
  enqueue answers 5xx so a redelivery retries. A repository no Workspace links
  mirrors nowhere. `issue_comment` events on unmerged pull requests are
  dropped before fan-out.
- **One workflow:** `github-sync-pull-request` mirrors the webhook's numbers,
  or, without numbers, backfills the 200 most recently updated merged pull
  requests. GitHub GraphQL returns a page of 20 with files, reviews, comments
  and review threads inline (one request per page, one durable step per
  page); REST reads one pull request only when a nested list overflows or a
  file was renamed (GraphQL has no previous path). Everything publishes as one
  commit, then `runConnectorRepositoryIngestionWorkflow` re-indexes the
  Workspace repository.
- **The link is the scope:** the mirror source is `{ provider: "github",
  gitUrl }` with no binding. The write broker's scope check
  (`assertConnectorMirrorScope`) is the single unlink authority: a write lands
  only if the Workspace tree still declares the repository in
  `repositories/*.md`. A mirror captured just before an unlink fails at that
  check instead of writing. Mirrored files stay in git.
- **Backfill trigger:** hydrate, before it records a revision's linked
  repositories, starts a backfill for each GitHub repository not yet in the
  Workspace's linked table (key `github-pr-backfill:<workspaceId>:<gitUrl>`).
  Links added in Settings and declarations committed with git are treated
  alike, and the step runs before the table changes so a replay still sees
  the link as new.
- **Connection:** the webhook's installation connection reads pull requests;
  a backfill uses the Workspace's GitHub connection. Without one the run skips
  as `no_source` and logs a warning.
- **No setup (dropped by this decision):** the `github/config.yaml` scope
  policy, the `connections.config.prMirror` binding with its setup phases, the
  install-time `contextRepository` field and every `ctxpipe-context` name
  heuristic are removed. Stale `prMirror` JSON in existing connection rows is
  ignored. Policy is fixed: merged and not draft.
- **Deploy:** queued runs of the retired `github-ensure-pr-mirror` and
  `github-sync-content` workflows complete as skipped through
  `github-pr-mirror-retired.ts` (delete it one release later). Queued
  `github-sync-pull-request` runs with the old input fail schema validation;
  accepted. Links that existed before this release get webhooks but no
  backfill, because their linked rows already exist.

Decisions 3–6 (paths, ingestion, deterministic graph, entity webhooks) stand,
with "context repository" read as "the Workspace repository".

## Context

GitHub source repositories are ingested as themselves (native git). Review
conversation, approvals, bot comments, and change lists are GitHub API
metadata, not git objects. Linear must keep GitHub pull requests as URL
references only ([ADR-022](ADR-022-linear-connector-git-native-mirror.md)).
Agents therefore see the merged tree and tidy docs, not the lived review
process that shapes how the company builds software.

The existing graph extractors will not invent pull-request nodes from Markdown.
`extractInstructionUnits` will LLM-read every `.md` file under a `./` root.
Dumping raw review threads into that machine is expensive and does not produce
typed change edges.

## Decision

1. GitHub remains one `connections` row (`type = github`). Pull-request
   capture is implied by repository setup, not a second product. `connections.config.prMirror`
   holds the context-repository binding (`repositoryId`, `branch`, `enabled`,
   `setupPhase`). No new connector type, no second OAuth app, and no user toggle.
2. Scope is the code-ingest picker. ctx| writes `github/config.yaml` on the
   context-repository target branch (no config PR to merge). The list is every
   ingested source repository except the context warehouse. Adding or removing
   picker repos updates that list. Operators may still edit the yaml to narrow
   a one-off backfill; the next picker sync overwrites it back to the picker.
   After the ingest picker, GitHub setup has a second step to create or confirm
   `ctxpipe-context`. That step is not a gate; skip on the picker still
   completes setup. ctx| does not auto-create the repository (that would need
   GitHub App Administration).
3. Content commits directly to the bound branch under
   `github/pulls/<owner>/<repo>/<number>--<id>.md`. One file per pull request:
   title, body, labelled human/bot reviews and comments, review decision, and
   changed **paths** with `added` / `modified` / `removed` / `renamed`. No
   diffs, patches, or CI logs.
4. After each successful write, run `runConnectorRepositoryIngestionWorkflow`
   on the context repository.
5. Graph extraction for these files is **deterministic** (no ReAct, no
   instruction LLM). It emits `PullRequest` and `File` objects and edges
   `ADDED` | `MODIFIED` | `REMOVED` | `RENAMED` from the pull request to each
   changed file, plus `TARGETS` to the source `Repository` and `File PART_OF`
   that repository (and owning package when classified). Locating `File` edges
   are graph-wide
   ([ADR-032](ADR-032-path-located-graph-edges.md)); PR change predicates are
   one instance. Instruction extraction skips all connector prefixes, not only
   `github/`.
6. Webhook `pull_request` (and review / PR conversation events) are **entity**
   signals for this mirror. They are not a fallback for source-repo reindex;
   default-branch `push` still owns that ([apps/backend README](../../../apps/backend/README.md)).

## Rationale

- Provenance stays on GitHub, so Linear attachments remain reference-only.
- Path-level change edges are available from the GitHub Files API without
  copying code that is already indexed on the source repository.
- File nodes are deduplicated by source repository + path so later pull
  requests share the same node.
- Promoting recurring review text into `InstructionUnit` / `Skill` is a later
  pass. This decision ships the warehouse and the change graph first.

## Consequences

- The hosted and self-host GitHub Apps already subscribe to `pull_request`;
  the handler must stop ignoring those events for bound mirrors.
- Conversation comments may require **Issues: Read**. Required-check
  conclusions require **Checks: Read**. v1 records review decision and file
  statuses with current Pull requests permission; extra signals land when
  those permissions exist.
- Context-repository ingest must not run the generic instruction LLM over
  any connector warehouse prefix (`github/`, `linear/`, `notion/`, `slack/`,
  `confluence/`).
- High-churn open pull requests are out of the default yaml (`states: [merged]`).
- Capture starts when GitHub repos are selected **and** a write target exists:
  an existing connector context repository, or an ingested `ctxpipe-context`.
  GitHub-only orgs with no context repository skip until one is bound (Linear,
  Notion, Slack, or they ingest `ctxpipe-context`). First sync is paced only
  by GitHub rate limits (default 200 newest merged PRs per source repo).
- Existing GitHub connections are swept on backend process start: each
  connection is enqueued to `ensureGithubPrMirror`. The call is idempotent
  (`unchanged` / `skipped_no_context`). This is how orgs that already selected
  repos pick up capture after deploy, without a picker re-save or a webhook.
- Connector setup (Linear, Notion, Slack, Confluence) preselects that same
  context repository: an existing connector bind if one is unambiguous, otherwise
  an ingested `ctxpipe-context` from GitHub setup.

## Alternatives considered

- **Expand Linear GitHub attachments:** Rejected; contradicts ADR-022 and
  blurs provenance.
- **Copy diffs into the context repository:** Rejected; double-indexes code
  already ingested from the source repository.
- **Query-time GitHub MCP as the durable path:** Rejected; git-native
  durability is the product store.
- **Overload `Decision` for every merged pull request:** Rejected; a merge is
  not a decision node. Change edges hang off `PullRequest`.
