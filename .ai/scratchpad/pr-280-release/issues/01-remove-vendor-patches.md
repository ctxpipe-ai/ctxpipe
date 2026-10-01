# Remove vendor patches

Status: plan-review
Priority: P0
Owner: unassigned
Blocked by: none
Created: 2026-10-01
Updated: 2026-10-01

## Context

The branch carries ~9.9k lines of `pnpm patch` against the chat and sandbox stack, despite the lock to stay on stock TanStack ([ADR-044](../../../memory/decisions/ADR-044-workspace-chat-stock-tanstack.md)). Most were added during recovery Gate 4 ([ADR-048](../../../memory/decisions/ADR-048-native-postgres-sandbox-ownership.md)) with "delete once upstream passes the retained proof" conditions.

| Patch | Lines | What it adds (per ADR-048) |
| --- | ---: | --- |
| `@tanstack/ai-sandbox-docker@0.3.2` | 5,493 | Egress proxy + per-run grants, isolation policy (CPU/mem/PID/disk, non-root), fork image ownership, remote-TLS port host, env/exec fixes, abort signals, stable container names |
| `@tanstack/ai-sandbox@0.5.0` | 2,063 | Runtime workspace on `ensure`/middleware/snapshot, live-revision transition hooks, handle admission (MCP port grants), Fs abort signals, snapshot persistence ordering |
| `@tanstack/ai-opencode@0.3.4` | 1,621 | Classify parts by message role, abort SSE before dispose, wait for `server.connected` and the assistant's terminal update, port-zero readiness URL |
| `@tanstack/ai-persistence@0.5.1` | 449 | Postgres thread lock + history validation under lock for concurrent sends |
| `@tanstack/ai-sandbox-local-process@0.2.4` | 189 | Cancellable fs calls |
| `@opencode-ai/sdk@1.18.18` | 24 | Swallow stream-reader cancel rejection; stop SSE retries after abort |
| `@langchain/langgraph@1.4.7` | 68 | (from `main`; out of scope unless trivially removable) |

Since then upstream moved: `@tanstack/ai` 0.48 → 0.63, `ai-sandbox` 0.5.0 → 0.5.17, `ai-opencode` 0.3.4 → 0.4.14, `ai-persistence` 0.5.1 → 0.7.1, `ai-sandbox-local-process` 0.2.4 → 0.2.6, `@opencode-ai/sdk` / `opencode-ai` 1.18.18 → 1.18.34. `ai-sandbox-docker` is still 0.3.2.

User decisions (2026-10-01): reduce patch debt as far as possible, changing our design where needed; isolation is limited to what stock TanStack sandbox policy supports (`commands`, `capabilities.fileWrite/network`, `default`) — **no quotas, egress proxy, or Btrfs runner**; provider is stock `dockerSandbox` for self-host and a Railway provider for managed (tickets 02, 03).

## Goal

Zero `@tanstack/*` and `@opencode-ai/*` entries in `patchedDependencies`. Any patch that survives has an upstream PR, a written reason it cannot be designed away, and a removal condition — and the user has accepted it explicitly.

## Acceptance criteria

- [ ] Every hunk in the six patches is classified (fixed upstream / dropped by decision / designed away / still required) in the ledger below.
- [ ] TanStack AI family and OpenCode upgraded to current releases.
- [ ] `patchedDependencies` has no `@tanstack/*` or `@opencode-ai/*` entries, or each survivor is accepted by the user with an upstream PR link.
- [ ] Application code that only existed to drive patched APIs is deleted (deletion ledger with line counts).
- [ ] Chat contract tests that motivated the patches pass on stock packages: two turns in one thread, reload/hydrate, cancel mid-stream, concurrent send on one thread, process restart + resume, per-conversation isolation.
- [ ] Typecheck, test policy, backend/UI/contract CI lanes green; preview chat smoke passes (preview-env `chat` area).
- [ ] ADR-044/048 updated to describe what actually ships (feeds ticket 08).

## Plan

1. **Ledger (no code changes).** For each patch hunk, record: the behaviour it adds, the contract test that proves it, the caller in our code, and a proposed class:
   - *Dropped by decision* — egress proxy, per-run grants, quotas, Btrfs, isolation policy enforcement, fork-image ownership tied to the custom runner, remote-TLS port host. Expected to remove most of the docker patch outright.
   - *Fixed upstream* — check changelogs/diffs between our pinned versions and current for: role-based part translation, SSE abort on dispose, `server.connected` wait, terminal-update ordering, port-zero readiness, persistence concurrency, fs abort signals.
   - *Designed away* — candidates: runtime workspace on `ensure` (replace with one stock `defineSandbox` per workspace + branch); live-revision transition hooks — **decided: option D** (SHA-free sandbox identity per conversation + in-sandbox git update via stock `exec` before a turn when the tip moved; current SHA recorded in our sandbox row); handle admission for MCP ports (gone with the egress proxy); persistence thread lock (serialize sends per thread in our route with the existing Postgres `LockStore`, or use upstream if 0.7 covers it).
   - *Still required* — anything left; prepare a minimal upstream PR.
   Output: a table in `## Comments` for the user to review before phase 2.
2. **Upgrade on a scratch branch with all patches removed.** Bump the TanStack AI family + `opencode-ai`/SDK to current, drop the patch files, run `pnpm install`, fix compile errors against the new APIs. Do not reintroduce patches; record every failing contract test against its ledger row.
3. **Apply design changes** for the "designed away" rows, one commit each, each with its proof test green and its dead code deleted.
4. **Upstream the remainder.** For each "still required" row, open a TanStack/OpenCode PR (or issue with repro). Until merged, keep only that minimal hunk as a patch and record the removal condition; ask the user to accept each one.
5. **Verify end-to-end.** Full CI lanes, preview deploy, preview-env `chat` + `files-publish` areas. Measure warm-turn latency against the PRD (~5 s first answer) and record before/after.
6. **Update ADR-044/048 and the deletion ledger**; close.

Unblocks tickets 02 and 03 (both build on the upgraded stock providers).

## Open questions

- **What happens to an open conversation when the workspace's default branch gets new commits?** (Decides whether the largest part of the `ai-sandbox` patch can go.)

  Today each conversation sandbox's identity includes the commit SHA it was cloned at. When the tip moves, the next turn needs a sandbox for the new SHA. The patch adds "transition hooks" to TanStack so the existing sandbox is moved to the new key in place; our own code (`workspace-chat-revision-transition.ts`) then stashes edits, rebases the conversation branch, and restores them. Options:

  | Option | Behaviour | Patch needed | Trade-off |
  | --- | --- | --- | --- |
  | A. Keep in-place move (today) | Sandbox moves to the new commit; edits kept | Yes (largest `ai-sandbox` hunk) | Freshest, invisible to the user, but the most patched, complex path |
  | B. Pin to start commit | Conversation stays on the commit it started from | No | Simplest; the agent reads stale knowledge; conflicts only surface when publishing a PR |
  | C. Restart on new commit | Next turn forks a new sandbox from the new base; uncommitted edits carried via `git diff`/`apply` | No | Fresh, but the first turn after a tip move is slower (fork + setup) and carried edits can conflict |
  | **D. Stable sandbox, update git in place (recommended)** | Sandbox identity excludes the SHA (branch only); before a turn, if the tip moved, run the existing stash/rebase script with stock `exec` | No | Fresh, edits kept, no patch. The base snapshot may lag the tip, so a new conversation does a small `git fetch` on its first turn; the sandbox record no longer proves its commit, so we keep the current SHA in our own row |

  **Decided (user, 2026-10-01): D.**
- If a concurrency fix is only available upstream in a version that changes the persistence schema, is a data migration of existing chat rows acceptable on this branch?

## Delegation brief

Read first: this ticket, ADR-044, ADR-048 (sections on patches, transitions, persistence lock), `pnpm-workspace.yaml` `patchedDependencies`, the patch files under `patches/`, `apps/backend/src/domain/workspaces/tanstack-workspace-chat.ts`, `sandbox-instance-store.ts`, `sandbox-lock-store.ts`, `workspace-chat-docker-policy.ts`.

Phase 1 only until the user approves the ledger. Do not add new patches or wrappers that restate TanStack APIs. Report: the ledger table, upstream diffs that close each item, and a list of application modules that become deletable.

## Comments

- 2026-10-01 (user): option D approved for revision changes.

- 2026-10-01 (user): asked what the revision-transition question means; trade-off table (options A–D) added under Open questions, recommending D.

## Resolution
