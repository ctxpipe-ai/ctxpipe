# Gate 4 deletion and proof ledger

| Retired owner / characterization | Retained behavioral oracle |
| --- | --- |
| Instance-store mock and cross-key model tests | Native PG store conformance (7 upstream cases) plus exact-key/revision preservation (2) |
| Process registry, memo, and health modules/tests | Two independent native Docker clients share one allocation; fresh process reads saved bytes; prepare preserves edits and refreshes credentials |
| Manual assistant-text filter, terminal repair, heartbeat/drain orchestration and mocked chat tests | Native HTTP POST + real OpenCode/proxy, exact assistant reply, two turns, one terminal, persisted transcript and reconstruct equality |
| Duplicate live/multiturn fixture suites and acknowledged fallback failure | Shared native fixture, host-key scrubbing, actual conversation POST, same proxy and OpenCode runtime |
| Legacy sandbox-key helper and fake-provider lifecycle tests | Native exact-key PG conformance, replica reuse, prepared credential/SHA worktree preservation |
| Mock prepare-route case | Native prepare HTTP followed by Files write/tree/status/read without opening a model turn |
| Registered-handle Files/publication fixtures | Native persisted binding and real Git; 16 publication race/policy cases; cleanup failure retention/retry |

The existing small conversations route suite retains unrelated route/parser characterization until deeper gate coverage replaces it. This checkpoint does not claim active-run restart, warm-call budgets, delete-vs-allocation races, Railway, or all Gate 4 acceptance complete.
