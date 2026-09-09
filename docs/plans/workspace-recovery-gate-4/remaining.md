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

1. Reconfirm the 4 GiB quota probe, GitHub HTTPS fixture observations,
   and overlapping-chat OpenCode session create on GitHub CI. Overlapping
   stale send passed on `1e0da797` (`34373200396`). The GitHub HTTPS
   fixture had no pass/fail line because `test-suite.mjs` hit its 30
   minute spawnSync ceiling after the quota test failed. Quota
   `enforces native Docker resource limits` failed at 150908ms (under the
   180s test timeout) with no assertion dump: 5120×1 MiB `conv=fsync`
   writes are too slow on nested Btrfs and still lose EDQUOT to OOM.
   The probe now uses 8 MiB `oflag=direct` seeks and keeps the last `dd`
   error on disk. The contracts spawnSync ceiling is 45 minutes; backend
   stays at 30.
   This host cannot run the Btrfs quota runner (`unknown filesystem type
   'btrfs'`). Do not substitute overlay Docker. Preserve ownership
   checks and dirty worktrees.
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

CI [34373200396](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34373200396)
on `1e0da797` ran contracts: overlapping stale send passed; quota
resource-limits failed at 150s; the 30 minute parent then `ETIMEDOUT`
so `contracts/results.json` was never written. Earlier
[34371493449](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34371493449)
on `9141fea2` died during Zoekt install before any contract ran. Do not
dispatch a duplicate of an unchanged SHA.

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
