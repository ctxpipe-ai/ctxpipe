# Gate 1 specification review — `29a082ae`

Reviewed exact pushed diff `7dfa6b93a5baedc3eb2c86dd1056662e89cace00...29a082aef00e603ddb79e38671dda83abc81e124`. `git ls-remote` confirms the authorized branch points to that full SHA.

## Finding

**P1 — A local test-function alias still bypasses blind-retry enforcement.** Gate 1 requires rejecting blind retries (`workspace-chat-recovery.md:611-612`). The policy initializes `tests` and `mocks` separately (`scripts/ci/check-test-policy.mjs:54-55`), but its alias pass updates only `mocks` (`:86-120`). Retry detection then depends on `tests.has(rootName(...))` (`:237-259`). Consequently this valid Vitest proof passes the policy with exit 0:

```ts
import { test } from "vitest"
const scenario = test
scenario("proof", { retry: 2 }, () => {})
```

The same gap applies to a namespace-derived alias such as `const scenario = v.test`. Propagate ordinary test-function aliases into `tests` and add direct regressions. Until then, the baseline's claim that aliased policy forms are enforced is too broad and green CI can conceal a new retry.

The two prior findings are fixed at this checkpoint: destructured/namespace mock aliases and Playwright `fail`/`fixme` are rejected, and every write characterization compares the complete `for-each-ref` snapshot while asserting the exact durable failure and absence of a domain job row. I found no further Gate 1 specification blocker in the reviewed implementation.

Code approval remains separate from Gate 1 closure. The production-build matrix and a final CI run on the reviewed checkpoint are still pending, as the baseline states; Gate 1 must not be marked complete until those results finish successfully.
