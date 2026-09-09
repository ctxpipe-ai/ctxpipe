# Gate 4 acceptance

Gate 3 closed at `20cf0791` with full CI 34295857469 and both cumulative reviews.
Gate 4 remains active; Gates 5–6 are not yet accepted. This file is the current
ledger. Detailed historical evidence remains in the linked validation files and
git history.

## Accepted evidence to preserve

| Item | Requirement | Current evidence |
| --- | --- | --- |
| G4-A | Native instance/lock stores; two replicas and restart reuse one worktree; no SQL connection held across provider IO | Native ownership, replacement semantics, lock renewal, and workspace/conversation deletion-allocation races pass |
| G4-B | Stock TanStack chat across HTTP/WS/prepare; native persistence, durability and reconstruction | Two turns, offsets, terminal/transcript equality, process reload, simultaneous-send preservation, cancellation and replay pass; one CI shutdown failure remains |
| G4-C | Warm reuse, captured revision, credentials, native shared bases/forks and provider selection | Warm GitHub budget, base reuse, revision conflicts/repair, process loss, Docker replacement and image collection pass; production provider/security activation remains open |
| G4-D | Files/publish/delete/idle use native handles; remove duplicate ownership/repair layers | Registry, memo and manual terminal repair removed; Files/publication/cancellation, persisted-first MCP targets and branch/run ownership pass; collision guards and final audit remain open |
| G4-E | Railway SDK conformance, live Bun chat and honest provider/deployment behavior | Native Docker capabilities have focused proof; sbx explicitly fails closed because disk/PID limits are unavailable; Railway live proof remains blocked on access |
| G4-F | Full entry-point audit, focused native evidence, full CI and two cumulative zero-blocker reviews | Pending final implementation and validation |

Key evidence:

- [Warm entry points](validation-warm-entrypoints.md) and [branch/run ownership](validation-branch-and-run-ownership.md).
- [Native bases and recovery](validation-native-bases-and-recovery.md).
- [Resources and Files](validation-native-resources-and-files.md): literal Git arguments, binary renames, native quota and fork-image ownership.
- [Processes and image](validation-native-process-and-image.md): native port allocation, nonroot prebuilt image and bounded process ownership.
- [Remote Docker](validation-remote-docker.md): published ports, authenticated Compose TLS, persistent Btrfs storage, replacement/restarts and nested callbacks.
- [Stream/provider corrections](validation-native-stream-and-provider.md): SSE readiness/completion and Docker request deadline regressions.
- [Native egress](validation-native-egress.md): exact model/tool routes, metadata/direct-route denial, revocable authenticated ingress, crash recovery, teardown retries and independent restart/fork ownership.

## Remaining work, in order

1. Obtain CI confirmation for the shutdown and PG collision corrections.
   Focused native checks and full backend/UI typechecks pass; existing dirty
   worktrees and legitimate revision moves are preserved without a key migration.
2. Activate the immutable chat image, 1 CPU / 1 GiB / 128 PID / 4 GiB limits and
   per-workspace egress together. Include policy generation in application
   identity. Never combine different tenants' private allowed hosts.
3. Prove the integrated Docker chat journey through the real model broker,
   tools and Git, including credential renewal during a long run and deployment
   recovery. Native egress proof alone does not establish production activation.
4. Finish Railway custom SDK provider acceptance and live Bun/resource/egress
   conformance. No Railway credentials were found in the task or checkout;
   the existing asynchronous access-location question remains unanswered.
5. Complete the entry-point/ownership audit, two cumulative reviews with no
   blockers, full CI and the authorized branch checkpoint. Then proceed to Gate 5.

## Current CI and cost controls

CI [34335463645](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34335463645)
on `d399d891` passed 12 jobs and 307 of 308 deterministic contracts. All five
failures from the preceding run are resolved, including Docker writer recovery
and native chat text delivery. The sole failure was the ten-second OpenCode
process-exit deadline in the published-conflict recovery case; that case and
four affected OpenCode checks now pass locally after bounded TERM/KILL cleanup. UI/CLI/CDK test
steps after contracts did not run. The resource/quota contract passes.

Backend/UI diagnostic allowances are 124/223, with no additions. Gate 6 must
resolve them. The complete recovery checkpoint passes both full typechecks.

The user authorizes all pushes to `codex/develop-plan-to-refocus-branch-direction`
and existing model-key use. Continue unattended; do not repeat those approvals.
Use targeted cheaper agents for independent subtasks. Reuse unaffected passing
evidence, run the full backend suite only in CI, and batch full typechecks/reviews
at coherent checkpoints. Never overlap dependency installs with runtime checks,
or run concurrent default OpenWorkflow owners. Keep new raw logs and machine
metadata in task-private work.
