# Gate 1 standards review — `05a3c6e41dacb473fbe8f64bef9aa2a0e05c751c`

**BLOCK — ADR-031 lines 33–34 requires CI to reject blind test retries.** `scripts/ci/check-test-policy.mjs:89-100,161-170,288-305` models bindings as one file-wide `Map` keyed only by identifier text, then compares source spelling. A later declaration in another lexical scope overwrites the binding used by an earlier test. This valid file exits 0 despite retrying twice:

```ts
import { test } from "vitest"
const retry = 2
test("proof", { retry }, () => {})
function unrelated() { const retry = 0; return retry }
```

Likewise, `const key = `retry`; test("proof", { [key]: 2 }, () => {})` exits 0 because line 296 strips only quote characters. This contradicts the claimed computed-key coverage. The regression inventory at `scripts/tests/ci-test-policy.test.mjs:42-49` covers only globally unique identifiers and a quoted computed key. Possible **Primitive Obsession**: binding identity and constant values are encoded as unscoped strings; use TypeScript symbols/scopes or retain declaration identity, and normalize string/no-substitution-template literals structurally.

The Node 22 dependency/build stages and 30-minute CI limits conform to ADR-031 lines 37–43; final production service stages remain Bun. Five script regressions and the 431-file scan pass, but they do not exercise these bypasses. Full CI remains a separate pending gate condition.
