# Gate 4 acceptance

Gate 3 closed at `20cf0791` with full CI 34295857469 and both cumulative reviews.
Gate 4 remains active; Gates 5–6 are not yet accepted. This file is the current
ledger. Detailed historical evidence remains in the linked validation files and
git history.

## Accepted evidence to preserve

| Item | Requirement | Current evidence |
| --- | --- | --- |
| G4-A | Native instance/lock stores; two replicas and restart reuse one worktree; no SQL connection held across provider IO | Native ownership, replacement semantics, lock renewal, and workspace/conversation deletion-allocation races pass |
| G4-B | Stock TanStack chat across HTTP/WS/prepare; native persistence, durability and reconstruction | Two turns, offsets, terminal/transcript equality, process reload, simultaneous-send preservation, cancellation and replay pass; CI concurrency correction remains |
| G4-C | Warm reuse, captured revision, credentials, native shared bases/forks and provider selection | Warm GitHub budget, base reuse, revision conflicts/repair, process loss, Docker replacement and image collection pass; production provider/security activation remains open |
| G4-D | Files/publish/delete/idle use native handles; remove duplicate ownership/repair layers | Registry, memo and manual terminal repair removed; Files/publication/cancellation, persisted-first MCP targets and branch/run ownership pass; collision guards pass; final audit remains open |
| G4-E | Railway SDK conformance, live Bun chat and honest provider/deployment behavior | Native Docker capabilities have focused proof; sbx fails closed because disk/PID limits are unavailable; Railway is a 503 selector only — no provider, SDK dependency, or live proof. SDK 3.11.0 also lacks CPU/memory/PID/disk/user/egress controls. Access is necessary but not sufficient |
| G4-F | Full entry-point audit, focused native evidence, full CI and two cumulative zero-blocker reviews | Pending final implementation and validation |

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

1. Reconfirm the 4 GiB quota probe and overlapping-chat OpenCode session
   create on GitHub CI. The overlapping case passed locally (unsandboxed,
   20.63s). The quota probe now writes 1 MiB seeks so BusyBox cannot
   buffer a 4 GiB fill and trip the memory cgroup. This host cannot run
   the Btrfs quota runner (`unknown filesystem type 'btrfs'`). Do not
   substitute overlay Docker. Preserve ownership checks and dirty
   worktrees.
2. Finish integrated acceptance of the activated immutable chat image,
   1 CPU / 1 GiB / 128 PID / 4 GiB limits and per-workspace egress. The factory,
   policy identity and credential-free deployment relay now have focused proof;
   the production HTTPS Git/quota preparation and recovery contract now passes.
3. Prove the integrated Docker chat journey through the real model broker,
   tools and Git, including credential renewal during a long run and deployment
   recovery. The real Git helper/broker already proves issuer-expiry renewal,
   native-owner revocation, unlink-during-mint rejection and the 500-repository
   boundary. Two native OpenCode turns pass with model run capabilities.
   These focused checks do not replace the integrated Docker journey.
4. Railway is a recognized selector that returns 503. There is no production
   provider, SDK dependency, detached cleanup branch, or live proof. SDK
   3.11.0 also lacks CPU/memory/PID/disk/user/capability and exact egress
   controls. No `RAILWAY_TOKEN` / `RAILWAY_ENVIRONMENT_ID` is provisioned.
   Access is necessary but not sufficient. Do not report Railway as
   implemented.
5. All three cumulative implementation review defects now have native green
   evidence and reviewer closure: provider-error propagation, immutable-image
   base collection, and detached cleanup after external agent loss. The proxy
   response-header deadline regression also passes. Complete the integrated
   journey, both final cumulative reviews and full CI before proceeding to Gate 5.

## Current CI and cost controls

CI [34361746839](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34361746839)
on `60ae1c10` is the current full run (Biome, typecheck, migrations, and
production builds already green; Tests still running). The previous run
[34352646163](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34352646163)
on `1c7b9657` passed 12 jobs and failed Required deterministic contracts
(2 failed / 327 passed): quota probe `Killed` before a quota error, and
overlapping chat `ECONNRESET` during session create. UI/CLI/CDK steps were
skipped. Job-row cleanup is not in that failure set. Do not dispatch a
duplicate of an unchanged SHA.

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
