# Gate 4 acceptance

Gate 3 closed at `20cf0791` with full CI 34295857469 and both cumulative reviews.
Gate 4 remains active; Gates 5–6 are not yet accepted. This file is the current
ledger. Detailed historical evidence remains in the linked validation files and
git history.

## Accepted evidence to preserve

| Item | Requirement | Current evidence |
| --- | --- | --- |
| G4-A | Native instance/lock stores; two replicas and restart reuse one worktree; no SQL connection held across provider IO | Native ownership, replacement semantics, lock renewal, and workspace/conversation deletion-allocation races pass |
| G4-B | Stock TanStack chat across HTTP/WS/prepare; native persistence, durability and reconstruction | Two turns, offsets, terminal/transcript equality, process reload, simultaneous-send preservation, cancellation and replay pass; overlapping stale send passed on CI `34384336581` |
| G4-C | Warm reuse, captured revision, credentials, native shared bases/forks and provider selection | Warm GitHub budget, base reuse, revision conflicts/repair, process loss, Docker replacement and image collection pass. Quota-Docker chat on CI `34410598235` streams two production-broker turns under 1 CPU / 1 GiB / 128 PID / 4G, binds the HTTPS workspace remote, and recovers a new handle after provider destroy. Credential renewal stays in the focused Git helper contract |
| G4-D | Files/publish/delete/idle use native handles; remove duplicate ownership/repair layers | Registry, memo and manual terminal repair removed; Files/publication/cancellation, persisted-first MCP targets and branch/run ownership pass; collision guards pass; final audit remains open |
| G4-E | Railway SDK conformance, live Bun chat and honest provider/deployment behavior | Native Docker capabilities have focused proof; sbx fails closed because disk/PID limits are unavailable; Railway is a 503 selector only — no provider, SDK dependency, or live proof. The prepare contract asserts that exact 503 without allocating a sandbox. SDK 3.11.0 also lacks CPU/memory/PID/disk/user/egress controls. Access is necessary but not sufficient |
| G4-F | Full entry-point audit, focused native evidence, full CI and two cumulative zero-blocker reviews | Full CI `34410598235` on `6f5c753b` is green (29/29; contracts 332/332). Two independent cumulative Sol reviews remain |

Key evidence:

- [Production activation and run credentials](validation-production-activation.md): immutable policy, credential-free relay replacement, native-owner capabilities and read-token renewal.

- [Warm entry points](validation-warm-entrypoints.md) and [branch/run ownership](validation-branch-and-run-ownership.md).
- [Native bases and recovery](validation-native-bases-and-recovery.md).
- [Resources and Files](validation-native-resources-and-files.md): literal Git arguments, binary renames, native quota and fork-image ownership.
- [Processes and image](validation-native-process-and-image.md): native port allocation, nonroot prebuilt image and bounded process ownership.
- [Remote Docker](validation-remote-docker.md): published ports, authenticated Compose TLS, persistent Btrfs storage, replacement/restarts and nested callbacks.
- [Stream/provider corrections](validation-native-stream-and-provider.md): SSE readiness/completion and Docker request deadline regressions.
- [Native egress](validation-native-egress.md): exact model/tool routes, metadata/direct-route denial, revocable authenticated ingress, crash recovery, teardown retries and independent restart/fork ownership.

## Remaining work, in order

1. Closed on CI
   [34384336581](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34384336581)
   (`21164618`): all 29 checks green. Contracts 330/330, including
   native resource limits (`25256ms`), overlapping stale send
   (`6798ms`), GitHub HTTPS fixture (`6081ms`), and prepare quota-Docker
   HTTPS clone (`78422ms`). This host still cannot run the Btrfs quota
   runner (`unknown filesystem type 'btrfs'`). Do not substitute overlay
   Docker. Preserve ownership checks and dirty worktrees.
2. Closed on CI
   [34410598235](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34410598235)
   (`6f5c753b`): the quota-Docker journey
   `quota Docker chat turn reaches the production model broker and Git remote`
   passed in `87823ms`. Isolation is 1 CPU / 1 GiB / 128 PID / 4G. The
   activated immutable image, HTTPS workspace remote, and nested OpenCode
   ingress forward are part of that contract. This host still cannot run
   the Btrfs quota runner; do not substitute overlay Docker.
3. Closed on CI `34410598235` as a scripted-broker journey, not a live LLM.
   Two production-broker turns go through
   `/${orgSlug}/api/v1/workspace-chat/openai/v1`, assert `git ls-remote`,
   preserve unsaved work on the first sandbox, and recover a new handle
   after provider destroy. The second turn reloads the stored transcript
   before appending. The fixture returns text only — no `tool_calls`.
   Focused Docker egress already owns tools. Credential renewal stays in
   `workspace-chat-git-credentials-native.contract.test.ts`. Nested
   OpenCode ingress is forwarded onto the GHA loopback by the contract;
   that helper is test-only and must not ship.
4. Closed as unsupported / fail-closed. Railway is a recognized selector
   that returns 503. There is no production provider, SDK dependency,
   detached cleanup branch, or live proof. SDK 3.11.0 also lacks
   CPU/memory/PID/disk/user/capability and exact egress controls. No
   `RAILWAY_TOKEN` / `RAILWAY_ENVIRONMENT_ID` is provisioned. Access is
   necessary but not sufficient. The prepare contract asserts the exact
   railway 503 without allocating a sandbox. Do not implement an SDK
   provider.
5. Independent cumulative reviews of `20cf0791...032c5b23` both returned
   `BLOCKED`. Shared blockers: per-call Docker `defineSandbox` rebuild,
   incomplete warm-turn budget proof, and dead `console.*` capture. Reviewer
   A also blocked on `tanstack-runtime` catch-and-empty and conversation-
   keyed OTEL. Those are being corrected on this SHA; do not write
   `Gate 4:` until both reviews are re-run at zero blockers and full CI is
   green. Reports:
   [reviewer A](checkpoint-032c5b23-reviewer-a.md),
   [reviewer B](checkpoint-032c5b23-reviewer-b.md).

## Current CI and cost controls

CI [34410598235](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34410598235)
on `6f5c753b` is green: backend 1201, contracts 332, UI 292, CLI 93,
CDK 32. Do not dispatch a duplicate of an unchanged SHA. The next SHA
is the Gate 4 ledger/review close, not a CI retry.

Backend/UI diagnostic allowances are 124/223, with no additions. Gate 6 must
resolve them. The current complete backend check passes with 124 diagnostics; the unchanged
UI passed with 223. The backend check includes the corrected typed Files error
responses, and no allowance was added.

The user authorizes all pushes to `codex/develop-plan-to-refocus-branch-direction`
and existing model-key use. Continue unattended; do not repeat those approvals.
Use targeted cheaper agents for independent subtasks. Reuse unaffected passing
evidence, run the full backend suite only in CI, and batch full typechecks/reviews
at coherent checkpoints. Never overlap dependency installs with runtime checks,
or run concurrent default OpenWorkflow owners. Keep new raw logs and machine
metadata in task-private work.
