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
- Not covered: lessons that apply across repositories (an org-level learnings
  repository proposed by pull request), and linking an engineer's correction to
  the advisor answer it contradicts. Both are needed before "self-learning"
  means learning from outcomes rather than from what is written down.

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
