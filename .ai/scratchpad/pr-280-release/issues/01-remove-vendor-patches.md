# Remove vendor patches

Status: plan-review
Priority: P0
Owner: unassigned
Blocked by: none
Created: 2026-10-01
Updated: 2026-10-02

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

Unblocks tickets 02 and 03 (both build on the upgraded stock providers; ticket 02 needs `@tanstack/ai` ≥ 0.63 for `@tanstack/ai-sandbox-cloudflare`).

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

- 2026-10-02 (user): phase 1 ledger approved. Exception: the three `@tanstack/ai-sandbox-vercel` gaps (start from snapshot, authenticated agent port, process kill) are temporary patches, upstreamed after production launch (ticket 02). Self-host Docker fast start: decision pending on the app-level per-Workspace base image (no patch).

- 2026-10-02 (claude): **Phase 1 ledger (for review before phase 2).**

  Sources: our patch files compared with the packages at the pinned versions and at current releases (`ai-sandbox` 0.5.17, `ai-opencode` 0.4.14, `ai-persistence` 0.7.1, `ai` 0.63.0, `@opencode-ai/sdk` 1.18.34; `ai-sandbox-docker` is still 0.3.2). "Verify" means phase 2 runs the contract test on stock packages and keeps a fix only if the test fails.

  | Package | Hunk | Class | How |
  | --- | --- | --- | --- |
  | ai-sandbox | Runtime workspace on `ensure` / middleware / snapshots; `onReady(handle, ctx)` | Designed away | Build one stock `defineSandbox` per Workspace for each request. Upstream already leaves the git token out of the sandbox key (`computeWorkspaceHash`), so a fresh token per request keeps the same sandbox. No registry. |
  | ai-sandbox | Git auth token as a SecretRef | Designed away | Pass the resolved token string. It is not hashed. |
  | ai-sandbox | `source.commit` checkout | Designed away (option D) | The key uses the branch. The commit is recorded in our sandbox row. A pre-turn `exec` fetches and rebases the session branch. |
  | ai-sandbox | Live-revision transitions (`transitionKey`, `move`, `findByTransitionKey`, `onWorkspaceTransition`, transition lock) | Designed away (option D) | The sandbox key has no SHA, so nothing moves between keys. `workspace-chat-revision-transition.ts` becomes the pre-turn update. |
  | ai-sandbox | Shared base snapshot (`baseSnapshot`, `threadSetup`, `injectSecrets`, base keys) | Designed away | Use stock `snapshot: 'after-setup'` per conversation. **Trade-off:** a new conversation clones the repository instead of restoring a shared base. Phase 5 measures first-answer latency against the ~5 s PRD. |
  | ai-sandbox | `hostBridgeAccess`, `SandboxChannel.close`, tool-bridge admission | Dropped by decision | Only existed for the egress proxy. |
  | ai-sandbox | Fs abort signals (`read`/`write`/`mkdir`/`remove`) | Dropped | Files routes check the request signal between operations instead. |
  | ai-sandbox | `deleteSnapshot` on the provider | Designed away | Our cleanup job removes snapshot images with the provider's own client (dockerode for Docker; ticket 02 covers Cloudflare). |
  | ai-sandbox | Deterministic `restoreSnapshot` id; persist the record before snapshotting; `AggregateError` on cleanup failure | Verify | These are robustness fixes for rare crash windows. Drop them unless a sandbox ownership contract fails. |
  | ai-opencode | Port-zero readiness (read the port from the "listening on" line) | Designed away | Each Docker or Cloudflare sandbox has its own network, so the stock fixed port is fine. For explicit `unsandboxed`, we pass a free port to `opencodeText`. |
  | ai-opencode | Stop with SIGTERM, then SIGKILL, with bounded waits | Verify | Risk: a lingering `opencode serve` in a reused sandbox holds the port for the next turn. Proof: the two-turn contract. If it fails, open an upstream PR. |
  | ai-opencode | Wait for `server.connected` and the assistant's terminal update; abort SSE before dispose | Verify | Proof: the HTTP two-turn and cancel-mid-stream contracts. If they fail, open an upstream PR. |
  | ai-opencode | Classify parts by message role (`translate.ts`) | Verify | Proof: the exact-text contract (no user text echoed as assistant text). If it fails, open an upstream PR. |
  | ai-opencode | Startup and cleanup diagnostics, `AggregateError` cleanup | Dropped | Nice to have; we log at our boundary. |
  | ai-persistence | Postgres thread lock plus history validation under the lock | Designed away | Wrap each send in our Postgres `LockStore.withLock("thread:<id>")` in the send runtime, held until the stream ends. Upstream `withLocks` only provides the capability; it does not lock threads. |
  | ai-sandbox-local-process | Cancellable fs calls | Dropped | Same as the Fs signals row. Local process is explicit-only. |
  | ai-sandbox-docker | Egress proxy, per-run grants, isolation enforcement (CPU/mem/PID/disk, non-root), Btrfs, fork-image ownership, remote TLS port host | Dropped by decision | Isolation is stock policy only (decision 2026-10-01). |
  | ai-sandbox-docker | Exec inherits the image env (stock `exec` replaces it, keeping only PATH/HOME) | Verify | Risk: OpenCode loses the image's tool paths or non-root home. If it fails, set the env through the stock workspace `env`/secrets before considering an upstream PR. |
  | ai-sandbox-docker | Create sends the name as a query parameter, separate from the body (credentials never in the URL); process wait registered at spawn | Verify on Bun 1.4.2 | If it fails, open an upstream PR. The credential-in-URL risk must not ship. |
  | ai-sandbox-docker | Stable container name; abort signals on create/resume | Verify | Stock already passes the deterministic key as `id`. |
  | @opencode-ai/sdk | `reader.cancel()` rejection handled; no retry after an intentional abort | Still required unless verify passes | Not fixed in 1.18.34. If the cancel contract shows an unhandled rejection or a retry loop, open an upstream PR (24 lines) and keep only this patch until it merges. |

  **Expected result:** every `@tanstack/*` patch removed. The `@opencode-ai/sdk` patch stays only if its contract fails. Three `ai-opencode` behaviors are uncertain and could need small upstream PRs; phase 2 settles them.

  **Code that becomes deletable** (sized in phase 3): `workspace-chat-revision-transition.ts` (reduced to the pre-turn update), the transition, base-snapshot and alias paths in `sandbox-instance-store.ts`, `workspace-chat-docker-policy.ts`, the egress, quota and replica contracts tied to the patched provider, `sandbox-egress-*`, and the Btrfs runner in CI ("Remove native sandbox quota runner").

  **Phase 2 needs:** approval of this table, especially the base-snapshot trade-off.

- 2026-10-01 (user): hosted chat moves to Cloudflare Sandboxes and conversation work is pushed to git (session branch) as the durable state. Option D still applies while a sandbox is alive; a wiped sandbox is recreated from the session branch.

- 2026-10-01 (user): option D approved for revision changes.

- 2026-10-01 (user): asked what the revision-transition question means; trade-off table (options A–D) added under Open questions, recommending D.

## Resolution
