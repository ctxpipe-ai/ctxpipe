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
proof remain open. Native low-level `handle.fork()` also has an inherited
intermediate-image ownership leak: implement failed-start cleanup, child teardown
ownership and process-loss collection before final gate closure. The production
shared-base path uses native snapshot restoration; do not confuse that passing
ownership proof with the low-level fork-image gap.

Files Git interpolation and binary rename data loss are fixed. Backend diagnostic
allowances shrink from 132 to 130. Five chat-related allowances remain (history
fixture, old graph agent/planner, WebSocket stream type, model-proxy fixture).
The local OpenCode port allocator remains pending native OS-assigned-port support;
remove its application Set and swallowed cleanup failure with that native change,
not an alternative application registry.

CI 34319040516 on 33503fd5 passed 12 jobs and failed only the Tests job: 292 of
293 deterministic contract tests passed. Its protected-conversation assertion
still expected an automatic session-branch switch, contradicting locked issue 14.
The corrected native contract now proves default-branch edits, an explicit
session-branch change, and permission-loss denial; it passes locally.
