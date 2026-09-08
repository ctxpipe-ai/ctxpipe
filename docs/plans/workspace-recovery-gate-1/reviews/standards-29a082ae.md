# Gate 1 standards review — third interim

Reviewed the full `7dfa6b93a5baedc3eb2c86dd1056662e89cace00...29a082aef00e603ddb79e38671dda83abc81e124` diff against root and affected-app `AGENTS.md`, the TDD proof guidance, ADR-031, and the required smell baseline.

## Code verdict

**PASS — zero documented-standard blockers.**

The prior policy blocker is resolved. `scripts/ci/check-test-policy.mjs:86-120` follows local and namespace framework aliases to a fixed point; lines 126-159 reject selector/mock destructuring; lines 160-235 reject direct, chained, and locally aliased access; and lines 131-140/171-180 include Playwright `fail` and `fixme`. The public regression at `scripts/tests/ci-test-policy.test.mjs:30-69` covers those red cases plus the intended green `vi.fn().mock.calls` observation. The complete 431-file policy scan passes, and all five CI-script regression tests pass under Node 22.16.0.

The new write-workflow characterization now compares the complete bare-remote ref inventory before and after each of all 12 write kinds (`apps/backend/src/domain/workspaces/write-workflow.contract.test.ts:49-54,120-127`), closing the earlier narrow `main`-only oracle. This remains explicitly authorized characterization under ADR-031:26-32, not claimed write proof.

## Nonblocking judgment

Possible **Duplicated Code** remains between the structured Vitest orchestration in `scripts/ci/test-suite.mjs` and `apps/codesearch/scripts/run-vitest-contracts.mjs`. Their shared inventory/report/validation shape could be extracted, but codesearch’s two-runtime routing is a legitimate specialization and this does not block Gate 1.

This approves the code on the Standards axis only. Gate 1 must remain open until the final CI run on this reviewed checkpoint supplies the pending production-build/toolchain evidence.
