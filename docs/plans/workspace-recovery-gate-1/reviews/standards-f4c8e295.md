# Gate 1 standards review — second interim

Reviewed the full `7dfa6b93a5baedc3eb2c86dd1056662e89cace00...f4c8e2959d2f9c77c48921655b1f52ce385f7480` diff against root/app `AGENTS.md`, TDD proof guidance, ADR-031, and the smell baseline. CI remains pending and is outside this code verdict.

## Blocker — documented standard

`scripts/ci/check-test-policy.mjs:90-160` still does not enforce ADR-031’s requirement to “Reject test selection modifiers, expected-failure tests … and owned collaborator substitution in proof” (`.ai/memory/decisions/ADR-031-required-recovery-ci.md:33-36`). The visitor recognizes only property/element access. Destructuring creates binding elements instead, so these ordinary aliases all exit 0:

```ts
import { test, vi } from "vitest"
const { skip } = test
const { mock } = vi
skip("omitted", () => {})
mock("./owned.js", () => ({}))
```

Namespace forms (`const { skip } = v.test`, `const { mock } = v.vi`) also pass. The regression cases at `scripts/tests/ci-test-policy.test.mjs:30-58` cover `const omit = test.skip` and direct `vi.mock`, but no binding-pattern aliases. In addition, the forbidden-property list at lines 102-104 includes Vitest `fails` but omits Playwright’s expected-failure API `test.fail()` (and `test.fixme()`); both pass even though `@playwright/test` is explicitly inventoried at lines 60-61. Add binding-pattern origin tracking and the Playwright modifiers, with red tests for each.

## Judgment calls

No additional baseline smell rises to blocker severity. The earlier live-fixture directory leak is fixed. The duplicated structured-result orchestration in `scripts/ci/test-suite.mjs` and `apps/codesearch/scripts/run-vitest-contracts.mjs` remains a possible **Duplicated Code** smell, but the Node/Bun split is a legitimate specialization and this is nonblocking.

Verdict: **Standards FAIL — 1 blocker, 1 nonblocking judgment.** Do not declare Gate 1 complete while this blocker or final CI remains pending.
