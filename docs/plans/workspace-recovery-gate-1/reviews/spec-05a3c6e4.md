# Gate 1 code verdict — `05a3c6e4`

Reviewed exact pushed checkpoint `05a3c6e41dacb473fbe8f64bef9aa2a0e05c751c`; `git ls-remote` confirms the branch ref. Two proof-policy blockers remain:

1. Computed retry keys are only partly resolved. `constantValue()` returns raw source for a no-substitution template literal, and quote removal excludes backticks. This valid proof exits 0:
   `const key = \`retry\`; test("proof", { [key]: 2 }, fn)`.
   Resolve static template literals (and preferably transparent parentheses/type wrappers) and add a regression.
2. Node's owned module-mock API is unguarded. `import { mock } from "node:test"; mock.module("./owned-store.js")` exits 0 because named `mock` is not tracked and `module` is not a checked method. Recognize this API, with an owned-module regression; include `bun:test`'s equivalent if Bun proof files may use it.

The shorthand, named/spread options, ordinary computed-string keys, getters, and zero-value case are otherwise implemented correctly. The five script tests and 431-file scan pass independently, but do not cover the two cases above.

Moving dependency/frontend build stages to Node 22 is within Gate 1 production-build scope and retains Bun runtime behavior. Final code approval and Gate closure remain pending these policy fixes and the new full CI result.
