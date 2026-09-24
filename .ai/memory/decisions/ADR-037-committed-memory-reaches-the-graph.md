# ADR-037: Committed memory reaches the graph

**Status:** Accepted | **Date:** 2026-09-24 | **Tags:** memory, cli, hooks, ingestion, graph

**Amends:** [ADR-024](ADR-024-markdown-only-local-memory-capture.md) (commit policy, work summaries) and [ADR-033](ADR-033-graph-ontology-v2.md) §8 (instruction sources).

## Context

ctx| is sold as a self-learning context layer. Its local half is agents learning
from engineers through `.ai/memory/` (ADR-024). Audit of that loop, 2026-09-24:

- **Nothing owned getting memory into git.** Hooks write only the gitignored
  inbox (by design); promoted Markdown sat in the working tree. In two other
  repositories using the CLI, promoted memory was stranded uncommitted on main
  checkouts and on a preview branch that never merges.
- **The episodic store was never written.** `sessions/` was seeded and described
  as "Episodic summaries", but no hook, skill or follow-up produced one; this
  repository has one note, from before ADR-024. The earlier `progress.md` /
  `active-context.md` log was gitignored.
- **Merged lessons never became instructions.** ADR-033 §8 classed every
  `.ai/memory/` file except ADRs as search-only documentation, so a rule in
  `AGENTS.md` became an `InstructionUnit` while the same rule in
  `lessons-learned.md` (where the CLI tells agents to write) did not.
- **Long instruction files were truncated** at 48,000 characters. Lessons are
  appended, so the newest were dropped first (this repository's file is 52 KB).

Hosts offer session-end and compaction hooks, but they are fire-and-forget
(Claude `SessionEnd` defaults to 1.5 s; Cursor `sessionEnd` ignores output), so
they cannot ask the agent to write anything. A chat session is also the wrong
unit: one pull request spans several sessions and hosts, and the pull request
is what the team reviews and merges.

## Decision

1. **Memory is committed with the work it came from**, on that work's branch —
   not a separate memory branch. Hooks still never commit. At Stop, capture
   surfaces uncommitted durable memory (`git status` on `.ai/memory`, excluding
   `events/`) once per branch + HEAD + file set, so a commit that leaves memory
   out surfaces it again. `memory status` and `memory doctor` report the same.
2. **The pull request description is the work summary** (the episode): what
   changed, why, what was tried and ruled out, follow-ups. It is reviewed with
   the code, and the pull request mirror (ADR-031) carries it into the graph
   attached to the changed files. `sessions/` remains only for work with no pull
   request. Summaries describe people by role, not by name or email.
3. **`.ai/memory/lessons-learned.md` is an instruction source** at tier 2
   (confidence 0.72, with `CONTRIBUTING` and norm-named docs), below agent files
   and rules (0.82): agents write it and it gets lighter review than `AGENTS.md`.
   Glossary, PRDs, product context and sessions stay search-only documentation.
4. **Instruction files over the per-call limit are extracted in
   heading-bounded chunks** instead of truncated. This applies to every
   instruction source, not only lessons.
5. **Claude Code gets the memory rule and capture skills** in `.claude/rules/`
   and `.claude/skills/` (repo or user scope), as Cursor does in `.cursor/`.
   Since 2.1.277 Claude Code reads `AGENTS.md` only as a fallback when no
   `CLAUDE.md` exists, and not on Bedrock, Vertex or Foundry, with telemetry
   off, or in the first session after an upgrade; `.claude/rules/` loads in
   every session. Init never creates `CLAUDE.md`, which would switch the
   `AGENTS.md` fallback off.
6. **Lessons are shared across repositories through the advisor**, with no new
   store. `ctx_advisor` search (vector and BM25) is scoped to the organization,
   not a repository, so a merged lesson from one repository reaches agents in
   every other.
7. **A correction of ctx| is an ordinary lesson.** It is recorded in Git and
   ingested at tier 2 like any other lesson. There is no server-side feedback
   store.
8. **VS Code and OpenCode capture through hooks too.** VS Code agent hooks
   (`.github/hooks/ctxpipe-memory.json`, `~/.copilot/hooks/`) use the Claude
   shape, with Stop continuation in `hookSpecificOutput`. OpenCode has no Stop
   hook, so a plugin (`.opencode/plugins/ctxpipe-memory.js`) observes
   `chat.message` and, on `session.idle`, posts the follow-up as a new message,
   as Cursor does with `followup_message`. Cursor and VS Code also run Claude
   Code hooks from `.claude/settings.json`: a `--host claude` hook running inside
   Cursor (`cursor_version` in the payload) or VS Code (`timestamp`, which Claude
   Code never sends) stands aside when that tool has its own ctxpipe hook, and in
   VS Code without one it answers in VS Code's format. This also stops Cursor
   capturing twice in repositories set up for both Cursor and Claude Code.

## Consequences

- Lessons reach the graph when a repository is next extracted with the file in
  scope (a change to it, or a full reindex); nothing is backfilled.
- Instruction files over 48,000 characters now cost one extraction call per
  chunk.
- The Stop notice spends one follow-up turn per new uncommitted file set; it is
  silent outside git and when memory is committed.
- Work summaries reach the graph only where the pull request mirror is enabled.
- Upgrade no longer treats a README mentioning `memory-search` (a current skill)
  as AgentMemory-era, and the glossary classifier no longer fires on the bare
  word "glossary".
- A lesson scoped to one repository can surface in another; the extracted
  `applicability.scope` is carried in the payload but retrieval does not filter
  on it.
- A correction does not lower the confidence of the facts behind the wrong
  answer; the advisor weighs both.
- OpenCode's reminder is a visible message after the turn and can race shutdown
  in headless runs; VS Code hooks are in preview.
- Not covered: demoting the facts behind a corrected answer (a feedback tool
  linking the correction to the advisor conversation). That is what would let
  ctx| learn from outcomes rather than from what is written down.

## Alternatives considered

- **Hooks auto-commit memory** — rejected: sweeps in staged work, runs
  pre-commit hooks mid-turn, and commits to whatever branch is checked out.
- **Side ref or git notes for episodes** (as Entire and git-ai do) — rejected:
  not reviewed in the pull request and not ingested with the branch.
- **Per-session or per-branch files under `sessions/`** — rejected: agents did
  not write them, and shared index files conflict across parallel worktrees
  (ADR-014).
- **Push local memory straight to the hosted graph** — rejected: bypasses Git as
  the reviewed source of truth.
- **Reach Claude Code through `AGENTS.md` or `CLAUDE.md`** — rejected: the
  `AGENTS.md` block is ignored wherever a `CLAUDE.md` exists, and writing
  `CLAUDE.md` would hide the rest of `AGENTS.md` from Claude.
- **Org-level learnings repository** for cross-repository lessons — not needed
  while advisor search is organization-wide.
- **Server-side `ctx_feedback` tool** that demotes the facts behind a corrected
  answer — deferred: needs a schema, a way to tie an answer to the facts it
  used, and a judgement step; a product decision on its own.
- **Rank corrections with agent rules** (a `Corrects:` line that raises the
  lesson to 0.82 and tells the advisor it overrides the advice it names) —
  deferred: agents write lessons and most pull requests here merge without
  human review, so the least-reviewed input would get the highest rank. A rank
  fixed at extraction also needs a reindex to change. Revisit with owner
  sign-off for corrections.
