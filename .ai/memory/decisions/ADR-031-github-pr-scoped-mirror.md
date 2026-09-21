# ADR-031: GitHub pull-request scoped mirror

**Status:** Accepted | **Date:** 2026-09-16 | **Tags:** connectors, github, git, graph, ingestion

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
   GitHub repository selection (onboarding and later setup) prompts the user to
   create or select `ctxpipe-context`. That prompt is not a gate; skip still
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
