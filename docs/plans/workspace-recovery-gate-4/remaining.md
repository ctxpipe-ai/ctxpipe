# Gate 4 acceptance

Baseline: Gate3 closed at20cf0791, fullCI34295857469 and both cumulative reviews passed. User approvals and cost controls persist. Targeted cheaper implementation agents are authorized; batch two-axis reviews at coherent milestones. Full backend suite runs only in CI.

| Item | Requirement and proof | State |
| --- | --- | --- |
| G4-A | Native SandboxInstanceStore + Postgres LockStore; exact key/full replacement conformance; restart and two replicas reuse one worktree; no SQL connection held across provider IO | Native ownership and both conversation/workspace deletion-allocation races passed |
| G4-B | Stock TanStack chat shared by HTTP/WS/prepare; native persistence/durability/reconstruct; two turns, resume offsets, one terminal, transcript equality, simultaneous sends | HTTP POST/two turns plus native WS offsets and fresh-process transcript reload passed; simultaneous-send preservation and cancellation pass after native package fixes; active WS abort/replay and successful retry now pass |
| G4-C | Valid warm turns avoid GitHub/tool reconstruction; stale revision and credential after prepare; native base snapshot/per-thread fork and provider selection | Static tools and exact captured-SHA/credential proof passed; static native definitions and unlocked Docker discovery now pass; warm GitHub request budget now passes; native base reuse/captured revision/credential separation, application wiring and last-owner image cleanup pass; live same-branch revision, conflict/repair, process-loss, Docker replacement, and unused-base collection proofs passed; legacy-owner, rewind/CAS, Files/push cancellation, current-target repair notices, and image-rotation collection proofs passed; remaining provider support open |
| G4-D | Files/publish/delete/idle cleanup use ensured native handles; remove registry/memo/manual terminal repair/catch-empty behavior; resolve acknowledged chat baseline | Registry/memo/terminal repair removed; Files/publication/retry proof passed; persistence catch-empty removed and conversation deletion race passed; MCP shared runtime/persisted-first target and cross-org run collision fixed; cold branch restoration and cross-thread run ownership fixed; native status is current-branch truth; Files and push retain transcript ownership through cancellable operations; final audit open |
| G4-E | Railway SDK provider conformance and live Bun chat spike; honest fallback/locked-provider behavior and deployment wiring | Pending; no Railway access configured in discovered task/checkout environment, asynchronous location question asked |
| G4-F | Complete entry-point/ownership audit, focused native evidence, full CI and two cumulative zero-blocker reviews; authorized push | Pending |

Use small native tests for each ownership invariant, reuse unaffected passing evidence, and keep later gates separate. Remaining native interfaces and constraints are summarized in the task work/gate4-preflight.md.

Latest bounded milestone: shared native bases and safe live revision transitions. Revision/Files/image review findings are closed on both axes; affected contracts, type baselines, migrations and formatting passed; push this batch before expanding the provider/security audit. New nonblocking review suggestions do not expand this milestone. User explicitly permits targeted cheaper subagents; use them only for independent bounded work.

The next checkpoint adds literal Git argument handling, byte-preserving Files
renames, and an opt-in native Docker resource contract with a Btrfs CI runner.
See [validation-native-resources-and-files.md](validation-native-resources-and-files.md).
It does not close Gate 4. Production chat image/egress/provider wiring and Railway
proof remain open. Native low-level `handle.fork()` intermediate-image ownership now has passing
real-Docker teardown, restart, snapshot-retention and failed-start regressions;
bounded standards review found no material blockers. The production
shared-base path uses native snapshot restoration; do not confuse that passing
ownership proof with the low-level fork-image gap.

Files Git interpolation and binary rename data loss are fixed. Backend diagnostic
allowances shrink from 132 to 130; the same fixed errors reduce UI allowances
from 225 to 223. The five chat-related diagnostics are resolved (history fixture, graph
stream/planner options, WebSocket callback and model-proxy fixture). Full backend
typecheck passes with 125 acknowledged diagnostics and no new/stale entries. Native OS-assigned-port support and bounded process cleanup replace the
application allocator; two concurrent real OpenCode servers pass health and
teardown checks. The non-root chat image passes native Git/OpenCode/resource
startup and disposal proof. See
[validation-native-process-and-image.md](validation-native-process-and-image.md).
Remote-Docker addressing now passes a real OpenCode health/disposal proof and a
retained native HTTP contract. Compose TLS/persistence passes native sandbox
recovery after replacement and three restart cycles. Stale containerd runtime
PID files and init ownership found during that proof are fixed. Native callback routing now passes a real nested Docker bearer/tool-call/close
proof. Production image/egress activation and integrated Docker chat remain
pending. The final combined backend check has 124 allowances after replacing an
unsafe environment fixture cast; all 12 affected proxy tests pass. UI remains223. See
[remote Docker evidence](validation-remote-docker.md).

CI 34319040516 on 33503fd5 passed 12 jobs and failed only the Tests job: 292 of
293 deterministic contract tests passed. Its protected-conversation assertion
still expected an automatic session-branch switch, contradicting locked issue 14.
The corrected native contract now proves default-branch edits, an explicit
session-branch change, and permission-loss denial; it passes locally.

CI 34323063810 on 6ff63064 exposed two stale UI allowances for the same backend
fixes; backend and all other type projects matched their allowances. Remove those
two UI entries exactly; no allowances are added. The completed run passed 11 jobs; its only other failure was the quota
contract's empty error file on the full filesystem (1,190 backend tests and
295/296 contracts passed). Capture that error through the host stderr stream
while retaining the exact quota-exceeded assertion, then run full CI on the new
checkpoint.

CI [34327385395](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34327385395)
on 1257e3f4 passed 12 jobs and all 1,186 default backend tests. The native
resource/quota contract now passes, including the exact quota-exceeded diagnostic.
The contract phase passed 297 tests and failed five: two native chat tests
returned no text despite successful terminal events, and three writer-recovery
tests encountered a Docker socket hang-up after sandbox creation. UI, CLI and CDK
test steps were skipped after that failure. The two chat cases pass locally;
subscription readiness is under investigation. A focused Bun native Docker
create/replay/exec/destroy probe passes, so the writer failure is not yet
attributed to the Docker request-body patch. Runner diagnostics and lifecycle
are being examined before another full CI run.

Provider selection now preserves `sbx` as its own identity instead of translating
it to Docker. Explicit locks retain precedence. The pinned sbx adapter has no disk/PID
enforcement, so it is ineligible for automatic selection. Explicit sbx chat and
write allocation refuse the provider without allocating a weaker fallback. This is honest failure behavior, not a claim of supported sbx execution.

The selector regression passes (2.29 seconds). Native preparation proves that a
locked sbx request returns 503 with no persisted allocation/model request, while
unlocked Docker still prepares, reuses and advances the existing worktree (two
cases, 115.64 seconds including startup). The initial native attempt was denied
loopback binding by the local sandbox; the authorized rerun is the passing proof.

The three CI Docker recovery failures are resolved by removing Docker Modem's
misleading two-second `connectionTimeout` from the writer provider. That timer
aborted requests while Docker was still performing a five-second stop; the
30-second request deadline and workflow abort signals remain. A controlled native
stop reproduced the failure at 2,014 ms; create replay then passed in 7.8 seconds,
and both process-loss boundaries passed together in 331.45 seconds. Failure
diagnostics preserve body and cleanup errors and report only credential-free
transport/owned-container state. Combined backend/UI typechecks pass with
124/223 allowances (84.37/107.13 seconds), with no new or stale entries.

The native SSE startup and prompt-completion races now have independent real
OpenCode red/green regressions. The installed native patch passes all three
port/startup/completion tests (9.10 seconds). See
[stream/provider checkpoint](validation-native-stream-and-provider.md).

The two original CI chat failures and native cancellation pass together (57.55
seconds). Final backend types pass with 124 existing allowances (90.89 seconds);
UI remains at 223. No diagnostic allowances were added. Full CI on this code
checkpoint is the next required confirmation.
