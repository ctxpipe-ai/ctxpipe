# Gate 1 specification review — `bec0c492`

Reviewed exact pushed checkpoint `bec0c492d051cd1d7a004f3d8b230f4e138de445`; `git ls-remote` confirms the authorized branch points to it.

The shared option rule and direct mutation checks fix the previously reported `fails` and `Object.assign(options, ...)` cases. One Gate 1 blocker remains: the policy still does not cover several ordinary supported ways to supply runner options, so “reject new” is not yet enforced completely.

All of these pass the checker with exit 0:

- `const o = Object.freeze({ retry: 2 }); test("p", o, fn)`; `Object.assign({}, { retry: 2 })` has the same call-produced-options gap.
- `const a = ["p", { fails: true }, fn] as const; test(...a)` because tuple argument spreads are not resolved.
- `import { test as scenario } from "./custom-fixture"; scenario("p", { retry: 2 }, fn)`, a common custom-fixture test API, because only framework-module imports seed aliases.
- A `vitest.config.ts` that imports and exports a retry-bearing object from a local helper; the helper is excluded by the file filter and imports are not resolved.
- Package/workflow test commands using runner CLI retry flags, which are outside the scanner.

These are bounded configuration surfaces, not a request for general JavaScript interpretation. Resolve or fail closed for call-produced option arguments, tuple spreads, custom named test imports, local config imports, and command-line retry settings; add one red regression per surface.

No other Gate 1 specification blocker was found. The production matrix passed at `05a3c6e4`, but final gate closure still requires green CI on the eventual reviewed checkpoint.
