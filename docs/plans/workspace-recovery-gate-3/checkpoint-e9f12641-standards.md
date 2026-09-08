# Standards review — `e9f12641`

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...e9f12641bd7a8cf9292db13a84f1c7199b982bc5`.

## Documented-standard violations (1)

### [P3] Remove direct console logging from the native pause proof

**File/hunks:** `apps/backend/src/domain/workspaces/write-pause-native.contract.test.ts:237,461`

The new cleanup diagnostics call `console.info("Native wait failure", …)` and `console.info("Protected write native failure", …)`. `apps/backend/AGENTS.md` says **“Do not use `console.*` in `apps/backend` — logs must go through evlog”** and explains that Vitest disables evlog through `src/test/setup-evlog.ts`. These calls bypass that policy and can add nondeterministic noise precisely when a test is already failing. Remove the diagnostics, include the run error in an assertion/helper failure, or use the prescribed logger if emitted diagnostics are necessary.

No implemented-scope correctness or transaction-boundary breach was found. Permission results are fenced by generation, URL, connection, default branch, and SHA; native acquisition and broker checks use atomic revision/status reads; prepared commits and workflow ownership survive access/protection waits; and conversation session-branch capability is enforced server-side and consumed by the UI.

## Fowler heuristic smells (0)

No new judgement-call smell. The repeated acquisition/push wait shape is intentional under ADR-033’s requirement that every typed workflow own explicit durable steps; the repository rule therefore overrides the Duplicated Code heuristic here.

**Result:** 1 documented standards cleanup, 0 heuristic smells, 0 product blockers. This is an intermediate-checkpoint review, not Gate 3 acceptance.
