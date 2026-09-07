# Gate 1 specification review — `f4c8e295`

Reviewed exact pushed diff `7dfa6b93a5baedc3eb2c86dd1056662e89cace00...f4c8e2959d2f9c77c48921655b1f52ce385f7480`; the branch ref resolves to that SHA. This remains an interim review because the production-build matrix and final reviewed-checkpoint CI run are pending.

## Findings

**P1 — The proof-policy check is bypassable, so Gate 1 cannot yet claim truthful enforcement.** Plan lines 611–612 require rejecting new skips, expected failures, blind retries, and owned module mocks in proof tests. At exact `f4c8e295`, `scripts/ci/check-test-policy.mjs:90-159` analyzes only property/element access. A proof can therefore evade it with destructuring, for example `const { mock } = vi; mock("./owned-store.js")` or `const { skip } = test; skip("proof", fn)`. The forbidden property list at lines 102–103 also omits Playwright's `test.fail()` and `test.fixme()`. The regression suite at `scripts/tests/ci-test-policy.test.mjs:30-58` covers chained/assigned property access and direct `vi.mock`, but none of these bypasses. Runtime report validation cannot identify an owned mock. Add BindingElement/alias tracking, cover `fail`/`fixme`, and add adversarial regressions before treating this policy as a Gate 1 guard.

**P2 — The write characterization overstates remote-ref immutability.** The baseline says every write case proves “no ... remote ref change” (`baseline.md:59-62`), but `apps/backend/src/domain/workspaces/write-workflow.contract.test.ts:114` compares only `refs/heads/main`. Creation or movement of another branch/tag would pass. Snapshot and compare all refs before and after, or narrow the baseline claim to `main`.

The write lane's current exact-error characterization is otherwise Gate 1 compliant: it executes every declared kind through real PostgreSQL/OpenWorkflow and exposes the existing failure. Gate 3, not Gate 1, owns successful commit/CAS/push behavior. Hydrate and chat claims are bounded accurately to the exercised Gate 1 behavior. No further Gate 1 specification blocker was found in the reviewed code; completion still depends on all production builds and a final CI run at the reviewed checkpoint.
