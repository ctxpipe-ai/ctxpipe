# Gate 2 SPEC review — third pass

Reviewed fixed base `d87858354a783a9fd95c46785208c9b699a45e3b` through pushed candidate `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`, including the full repository, every revision reader/writer, the Gate 0 manifest, locked tickets/ADRs, the second review and supplement, and the correction diff `50db2359..bb24210c`. The three-dot diff is nonempty, both refs resolve, the worktree is clean, and the candidate matches its remote branch. **Code verdict: PASS — no blocking SPEC finding.**

The two defects found during this pass are fixed in the reviewed SHA:

- Hydrate now requires a strict, complete `WorkspaceRevision` and parses stored input again inside the worker. Old primitive OpenWorkflow runs fail without being rebound to the current branch or connection; ADR-032 documents recapture through normal cron/retry scheduling. Resolver and production callers now accept/carry only the canonical value.
- Native reads initialize their temporary repository with SHA-1 or SHA-256 according to the validated immutable SHA. A real SHA-256 repository acquisition contract passes.

The six second-review blockers also close: connection changes are transactionally fenced; previous indexes remain readable; null tips resolve before enqueue; missing `valid_from` uses each file’s introducing commit; Falkor publication/readiness is revision-scoped; and Files/chat use captured immutable checkouts including glob/get-file. Remaining provider `getContent` calls are write/config paths owned by later gates. Retired immutable graph revision garbage collection correctly remains Gate 6 work coordinated with captured conversation lifetime.

Committed proof reports 130/130 mandatory cases in 18 files with zero skips/allowances, backend typecheck at the unchanged 146 allowance, proof policy pass, Linux packaging/runtime at 173 Node plus 42 Bun tests, and Kubernetes memory/cleanup pass at 5,230,137,344 bytes under 5,670 MiB.

Terminal acceptance is pending exact-`bb24210c` CI, which was dispatched during review. This is an acceptance condition, not a code blocker or missing local evidence.
