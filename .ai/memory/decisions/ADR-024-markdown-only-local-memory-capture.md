# ADR-024: Markdown-only local memory with candidate-first capture

**Status:** Accepted | **Date:** 2026-08-11 | **Tags:** memory, cli, agents, hooks, local-first

**Supersedes:** [ADR-021](ADR-021-local-agent-memory-agentmemory-hybrid-mcp-proxy.md)

## Context

ADR-021 wired a hybrid path: repo Markdown plus a disposable local search runtime hydrated from `.ai/memory/`. In practice that split the product:

- Curated Markdown (ADRs, glossary, product context) was not the same shape as MCP-saved records.
- CLI `memory init` seeded only a README and an MCP server, not the full harness used in this monorepo.
- Agents needed a clearer, Git-native navigation model without a second search process.

We need durable memory that stays reviewable in Git, works for Cursor and other common coding agents, and is installed the same way for CLI users via `ctxpipe memory init`.

## Decision

1. **Canonical store** is Markdown under `.ai/memory/` only (not public documentation trees).
2. **Navigation** is `index.md` files (root + per subdirectory). Agents update indexes when they add or change durable entries. There is **no** local search daemon and **no** hosted embeddings path for memory recall.
3. **Candidate-first capture:** host lifecycle hooks call `ctxpipe memory capture observe|summary`. Hooks redact, classify, and append to **gitignored** `.ai/memory/events/`. Hooks never write durable ADRs or lessons.
4. **Promotion** is agent-driven via skills/rules into durable files (`lessons-learned.md`, `glossary.md`, `decisions/`, `PRDs/`, `sessions/`, `product-context.md`) plus index updates.
5. **Hooks and capture logic live in the CLI** (TypeScript), invoked as `npx ctxpipe memory capture …`. Init installs thin host configs for the agents the user selects (`cursor`, `claude`, `codex`, `opencode`, `vscode` — same picker as today).
6. **Full init** seeds the memory layout, always-apply memory rule, capture skills, gitignore for events, and selected-agent hooks.

### Layout

```
.ai/memory/
  README.md
  index.md
  lessons-learned.md
  glossary.md
  product-context.md
  PRDs/index.md
  decisions/index.md + ADR-NNN-*.md
  sessions/index.md + YYYY-MM-DD-*.md
  events/   # gitignored (except .gitkeep)
```

### Events schema (runtime, not committed)

Observe appends JSON lines under `.ai/memory/events/` (`events/YYYY-MM-DD.jsonl`, `candidates.jsonl`, `lifecycle.json` for pending→surfaced→promoted|dismissed). Fields include host, event type, redacted excerpts, classification kind, and suggested destination. Fail-open: capture exits 0 on errors.

## Consequences

- Remove AgentMemory supervisor/hydration/`ctxpipe-memory` MCP from default memory init.
- Retire legacy memory-sync/search/handoff skills in favor of capture/promote skills and the always-apply rule.
- Observe classifies **user prompt and assistant text only**. It must not mint candidates from tool dumps, Stop follow-up prompts, or promotion writes under durable `.ai/memory/` files.
- Cursor project hooks observe **`beforeSubmitPrompt` only** (plus Stop finalize). `afterFileEdit` / `postToolUse` classified MCP schemas, grep output, and test edits as lessons; those events are not installed for Cursor and leftover tool-sourced pending ids are dismissed on summarize.
- Cursor Stop `followup_message` is injected as a **new user turn**. Observe must ignore that payload (including nested/wrapped prompt shapes). Emitting another `followup_message` when Cursor `loop_count >= 1` would recapture the same text as a new lesson.
- Cursor Stop `followup_message` is one-shot for never-shown **user-prompt** candidates so promotion turns cannot recapture themselves. Installed Cursor `stop` hooks set `loop_limit: 1` as a backstop (Cursor 3.11 defaults to 5).
- This monorepo’s project hooks run the in-repo CLI from source (not `npx ctxpipe`). Published 0.3.0 still classifies the follow-up as a lesson; a stale `packages/cli/dist` has the same bug.
- ADR-021 remains historical; new work follows this ADR.
- Backend OpenAI-compatible proxy may remain for other product features; it is not required for local memory recall.

## Alternatives considered

- Keep hybrid search runtime — rejected (split brain, ops cost, weaker Git review story).
- Auto-write durable ADRs from hooks — rejected (noisy, skips human/agent review).
- Python capture scripts in each repo — rejected (CLI-owned TypeScript, one install path).
