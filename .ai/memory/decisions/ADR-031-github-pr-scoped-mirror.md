# ADR-031: GitHub pull-request scoped mirror

**Status:** Accepted (amended 2026-10-05) | **Date:** 2026-09-16 | **Tags:** connectors, github, git, graph, ingestion

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

## Amendment (2026-10-05): issues

7. Issues are captured implicitly, like pull requests: every issue of the
   selected repositories, with no toggle. Per-repository or label filtering
   waits for workspaces. Issues use the same binding, picker scope
   (`pullRequests.repositories`) and lifecycle as pull requests. `github/config.yaml` gains
   `issues: { maxIssuesPerRepository }`. Its presence marks a yaml written
   after issue capture shipped; the startup sweep (key `v2`) rewrites a yaml
   without it. That rewrite also re-runs the pull-request backfill once per
   binding. No new connection type, toggle or table.
8. Content is `github/issues/<owner>/<repo>/<number>.md`: frontmatter
   (`type: issue`, state, labels, assignees, timestamps), body, and every
   comment. The number is the path id; GitHub never reuses or changes it.
9. Reads are GraphQL: one request per 50 issues with the first 100 comments
   inlined, plus one per further 100 comments of one issue. The backfill is
   one durable step per repository (`issues-<repo>`) that reads, renders and
   commits that repository: open and closed, newest updated first, default
   200. Not a step per page: OpenWorkflow caps a run at 1,000 steps, and the
   cap bounds a step to a few requests and one repository's files in memory.
   A repository the App cannot read (GraphQL `FORBIDDEN` without
   **Issues: Read**, `NOT_FOUND` without access) is skipped, so pull-request
   capture still completes. Any other error fails the run, and the next sync
   retries it.
10. Live updates: `issues` actions that change the file (opened, edited,
    closed, reopened, labeled, unlabeled, assigned, unassigned) and
    plain-issue `issue_comment` run `github-sync-issue`. Not yet: removing
    deleted or transferred issues, and copying embedded images as assets
    ([ADR-028](ADR-028-git-native-connector-assets.md)); images stay links,
    as in the pull-request mirror.
11. Graph: `Issue` keyed `iss:${sourceRepositoryId}:${number}`, `Issue PART_OF
    Repository`. An issue of a repository that is not connected is skipped.
    A mirrored pull request that writes `#N`, `owner/repo#N` or an issue URL
    of its own repository, outside code, records `PullRequest REFERENCES
    Issue`. No stubs: issues and pull requests share one number sequence, so
    a `#N` that is a pull request resolves to no issue and is dropped.

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
