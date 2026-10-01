# Consolidate intent and ADRs

Status: ready-for-agent
Priority: P0
Order: 1 (first)
Owner: unassigned
Blocked by: none
Created: 2026-10-01
Updated: 2026-10-01

## Context

The user confirmed the branch's ADRs are not accurate. ADR-045–048 (recovery CI, revision identity, durable writes, sandbox ownership) are long, partly contradictory (e.g. ADR-048 says the Docker chat journey is open while Gate 4 was closed), and describe patch-based designs that tickets 01–03 are removing. Product intent is spread across the wayfinder map and 19 issues under `../../git-backed-projects/`, three PRDs in `.ai/memory/PRDs/workspace-chat-*.md`, the glossary, lessons-learned, and ADR-040–048. None of this has merged to `main` yet, so it can be rewritten rather than superseded.

User decisions to reflect (2026-10-01): managed sandboxes on Railway Sandboxes; self-host on stock `dockerSandbox` (Compose dind, CDK EC2 Graviton host); unsandboxed only as an explicit last resort; isolation limited to stock TanStack policy; reduce vendor patches; `@ctxpipe/aws-cdk` ships as a minor.

## Goal

One accurate, short statement of what this branch ships — a product intent document plus ADRs that each record one decision the code actually implements — so later tickets (07 first) have a single target to check against.

## Acceptance criteria

- [ ] Claims ledger: every decision statement in the map's "locked" notes, ADR-040–048, and the workspace-chat PRDs, marked `true` / `false` / `superseded` / `changing (ticket NN)` with code evidence.
- [ ] `.ai/memory/PRDs/workspaces.md`: the product intent for git-backed Workspaces as shipped — Workspace identity, workspace repository and linked repositories, git-canonical knowledge, jobs, hydrate/projection, chat and sandboxes, publish rules, UI information architecture, deploy targets. Links to wayfinder issues as history only.
- [ ] ADR-040–048 rewritten in place to the decisions the code implements, each well under one page, using the `capture-adr` format; sandbox/chat ADRs carry a "changing in tickets 01–03" note instead of describing patched behaviour.
- [ ] Decisions index, glossary, lessons-learned, product-context, and the map's destination reconciled with the above (no contradictions left; stale lessons removed).
- [ ] App/root `AGENTS.md` pointers checked; any needed edits listed for the user (auto mode blocks agent-instruction edits).
- [ ] User reviews and approves the PRD and rewritten ADRs.

## Plan

1. **Collect sources.** Map + issues 01–19, PRDs, ADR-040–048, glossary, lessons-learned (branch entries), product-context, app AGENTS.md files.
2. **Claims ledger.** Split each source into individual decision claims; check each against code (file:line evidence) and the user decisions above. Record in `## Comments` as a table.
3. **Draft the PRD** (`workspaces.md`) from `true` claims plus user decisions; mark open areas that tickets 01–03 will settle.
4. **Rewrite ADRs** 040–048 to match; merge or drop any that collapse (e.g. 043 keep-alive is already superseded — keep as a one-paragraph record). Keep numbering stable so links survive.
5. **Reconcile memory files** (index, glossary, lessons, product-context, map destination).
6. **User review**, then commit. Re-check sandbox/chat ADRs when tickets 01–03 close.

## Delegation brief

Read first: this ticket, `../../git-backed-projects/map.md` and its issues, `.ai/memory/PRDs/`, `.ai/memory/decisions/ADR-040…048`, `.ai/memory/glossary.md`, `.ai/memory/lessons-learned.md`, `.ai/memory/product-context.md`, `.cursor/skills/capture-adr/`, `.cursor/skills/writing-for-agents/`.

Verify every claim in code before keeping it. Write short, plain decisions; no implementation diaries. Report the claims ledger and the drafts for user review before committing.

## Comments

- 2026-10-01 (user): approved; this ticket goes first. Plan expanded from the sketch.

## Resolution
