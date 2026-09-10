# Gate 4 acceptance

Gate 3 closed at `20cf0791` with full CI 34295857469 and both cumulative reviews.
Gate 4 closed at this commit with full CI
[34421467470](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34421467470)
on `79670977` (contracts 334/334) and both cumulative reviews of `f8e4fae9`
returning `CLOSE_GATE_4`. Gates 5–6 remain pending. This file is the closed
ledger. Detailed historical evidence remains in the linked validation files and
git history.

## Accepted evidence to preserve

| Item | Requirement | Current evidence |
| --- | --- | --- |
| G4-A | Native instance/lock stores; two replicas and restart reuse one worktree; no SQL connection held across provider IO | Native ownership, replacement semantics, lock renewal, and workspace/conversation deletion-allocation races pass |
| G4-B | Stock TanStack chat across HTTP/WS/prepare; native persistence, durability and reconstruction | Two turns, offsets, terminal/transcript equality, process reload, simultaneous-send preservation, cancellation and replay pass; overlapping stale send passed on CI `34384336581` |
| G4-C | Warm reuse, captured revision, credentials, native shared bases/forks and provider selection | Warm GitHub budget, base reuse, revision conflicts/repair, process loss, Docker replacement and image collection pass. Quota-Docker chat on CI `34421467470` streams a prepared turn, a same-sandbox warm Send, and a recovered turn through the production broker under 1 CPU / 1 GiB / 128 PID / 4G, binds the HTTPS workspace remote, and recovers a new handle after provider destroy. Credential renewal stays in the focused Git helper contract |
| G4-D | Files/publish/delete/idle use native handles; remove duplicate ownership/repair layers | Registry, memo and manual terminal repair removed; Files/publication/cancellation, persisted-first MCP targets and branch/run ownership pass; collision guards pass; final product audit remains Gate 6 |
| G4-E | Railway SDK conformance, live Bun chat and honest provider/deployment behavior | Native Docker capabilities have focused proof; sbx fails closed because disk/PID limits are unavailable; Railway is a 503 selector only — no provider, SDK dependency, or live proof. The prepare contract asserts that exact 503 without allocating a sandbox. SDK 3.11.0 also lacks CPU/memory/PID/disk/user/egress controls. Access is necessary but not sufficient |
| G4-F | Full entry-point audit, focused native evidence, full CI and two cumulative zero-blocker reviews | Full CI `34421467470` on `79670977` is green. Contracts 334/334, including the quota-Docker prepare reuse (`37666ms`) and production-broker journey (`83710ms`). Independent Sol reviews of `f8e4fae9` both returned `CLOSE_GATE_4` |

Key evidence:

- [Production activation and run credentials](validation-production-activation.md): immutable policy, credential-free relay replacement, native-owner capabilities and read-token renewal.
- [Warm entry points](validation-warm-entrypoints.md) and [branch/run ownership](validation-branch-and-run-ownership.md).
- [Native bases and recovery](validation-native-bases-and-recovery.md).
- [Resources and Files](validation-native-resources-and-files.md): literal Git arguments, binary renames, native quota and fork-image ownership.
- [Processes and image](validation-native-process-and-image.md): native port allocation, nonroot prebuilt image and bounded process ownership.
- [Remote Docker](validation-remote-docker.md): published ports, authenticated Compose TLS, persistent Btrfs storage, replacement/restarts and nested callbacks.
- [Stream/provider corrections](validation-native-stream-and-provider.md): SSE readiness/completion and Docker request deadline regressions.
- [Native egress](validation-native-egress.md): exact model/tool routes, metadata/direct-route denial, revocable authenticated ingress, crash recovery, teardown retries and independent restart/fork ownership.
- Reviews: [032c5b23 A](checkpoint-032c5b23-reviewer-a.md), [032c5b23 B](checkpoint-032c5b23-reviewer-b.md), [058a4a3b A](checkpoint-058a4a3b-reviewer-a.md), [058a4a3b B](checkpoint-058a4a3b-reviewer-b.md), [f8e4fae9 A](checkpoint-f8e4fae9-reviewer-a.md), [f8e4fae9 B](checkpoint-f8e4fae9-reviewer-b.md).

## Closed work

1. Closed on CI
   [34384336581](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34384336581)
   (`21164618`): native resource limits, overlapping stale send, GitHub HTTPS
   fixture, and prepare quota-Docker HTTPS clone. This host still cannot run the
   Btrfs quota runner (`unknown filesystem type 'btrfs'`). Do not substitute
   overlay Docker.
2. Closed on CI
   [34421467470](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34421467470)
   (`79670977`): the quota-Docker journey
   `quota Docker chat turn reaches the production model broker and Git remote`
   passed in `83710ms`. Isolation is 1 CPU / 1 GiB / 128 PID / 4G. The activated
   immutable image, HTTPS workspace remote, nested OpenCode ingress forward, and
   same-sandbox warm Send are part of that contract.
3. Closed as a scripted-broker journey, not a live LLM. Two production-broker
   turns go through `/${orgSlug}/api/v1/workspace-chat/openai/v1`, assert
   `git ls-remote`, preserve unsaved work on the first sandbox, reuse that
   sandbox for a warm Send (no extra provider create or image inspect; instance
   `hits` increment), and recover a new handle after provider destroy. The
   fixture returns text only — no `tool_calls`. Focused Docker egress already
   owns tools. Nested OpenCode ingress is test-only and must not ship.
4. Closed as unsupported / fail-closed. Railway is a recognized selector that
   returns 503. There is no production provider, SDK dependency, detached
   cleanup branch, or live proof. Do not implement an SDK provider.
5. Closed after `f8e4fae9` reviews (`CLOSE_GATE_4`) and green CI `34421467470`.
   CI `34418188719` on `f8e4fae9` had failed because a rejected image inspect
   was reused and nested OpenCode HostPort `32768` collided with the quota
   Docker API. `79670977` drops failed inspects, keys successful inspects by
   daemon and image, and publishes the quota API on `127.0.0.1:23755-23799`.

## Current CI and cost controls

CI [34421467470](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34421467470)
on `79670977` is green. Contracts 334/334. Do not dispatch a duplicate of an
unchanged SHA. The next SHA is Gate 5 frontend ownership work.

Backend/UI diagnostic allowances are 124/223, with no additions. Gate 6 must
resolve them.

The user authorizes all pushes to `codex/develop-plan-to-refocus-branch-direction`
and existing model-key use. Continue unattended; do not repeat those approvals.
Use targeted cheaper agents for independent subtasks. Reuse unaffected passing
evidence, run the full backend suite only in CI, and batch full typechecks/reviews
at coherent checkpoints. Never overlap dependency installs with runtime checks,
or run concurrent default OpenWorkflow owners. Keep new raw logs and machine
metadata in task-private work.
