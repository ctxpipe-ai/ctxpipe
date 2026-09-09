# Gate 4 acceptance

Baseline: Gate3 closed at20cf0791, fullCI34295857469 and both cumulative reviews passed. User approvals and cost controls persist. No implementation agents; batch two-axis reviews at coherent milestones. Full backend suite runs only in CI.

| Item | Requirement and proof | State |
| --- | --- | --- |
| G4-A | Native SandboxInstanceStore + Postgres LockStore; exact key/full replacement conformance; restart and two replicas reuse one worktree; no SQL connection held across provider IO | Core proof passed; deletion/allocation race still open |
| G4-B | Stock TanStack chat shared by HTTP/WS/prepare; native persistence/durability/reconstruct; two turns, resume offsets, one terminal, transcript equality, simultaneous sends | HTTP POST/two turns/reconstruct passed; WS/restart/offset/simultaneous proof remains |
| G4-C | Valid warm turns avoid GitHub/tool reconstruction; stale revision and credential after prepare; native base snapshot/per-thread fork and provider selection | Pending |
| G4-D | Files/publish/delete/idle cleanup use ensured native handles; remove registry/memo/manual terminal repair/catch-empty behavior; resolve acknowledged chat baseline | Registry/memo/terminal repair removed; Files/publication/retry proof passed; remaining catch-empty and deletion race audit open |
| G4-E | Railway SDK provider conformance and live Bun chat spike; honest fallback/locked-provider behavior and deployment wiring | Pending; no Railway access configured in discovered task/checkout environment, asynchronous location question asked |
| G4-F | Complete entry-point/ownership audit, focused native evidence, full CI and two cumulative zero-blocker reviews; authorized push | Pending |

Use small native tests for each ownership invariant, reuse unaffected passing evidence, and keep later gates separate. Remaining native interfaces and constraints are summarized in the task work/gate4-preflight.md.
