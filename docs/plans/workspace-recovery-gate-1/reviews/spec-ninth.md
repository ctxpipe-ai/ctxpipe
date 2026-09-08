# Gate 1 specification review — `d64f351c`

Reviewed exact pushed checkpoint `d64f351c6b1b46dc1375639fa69faf2c52b4d917`; `git ls-remote` confirms the authorized branch points to it. The prior option-construction, tuple-spread, custom named-test import, local ESM config graph, and same-line CLI findings are addressed. Remaining findings are confined to the Gate 1 policy guard.

## Blocking false negatives

1. A GitHub Actions folded scalar passes: `run: >` with `vitest run` and `--retry=2` on successive lines is one shell command, but the checker scans each line independently. Parse YAML scalars or join folded blocks.
2. `vitest --config ./custom-vitest.ts` passes while the custom file is outside source discovery. Resolve `--config` targets or reject custom paths. Apply the same rule to Playwright.
3. The scanner excludes the `.mjs` files that construct Gate 1 runner argv, including `scripts/ci/test-suite.mjs` and the codesearch runner. A literal retry flag added there is invisible. Inspect the finite CI runner scripts.
4. Although `.cjs` configs are discovered, static relative `require("./shared-options.cjs")` dependencies are not followed; only ESM import/re-export declarations are. Traverse static local `require()` calls.

## Blocking policy false positives

5. Every namespace import, including an application helper, is seeded as a test and mock API. A normal `helpers.assert(buildSubject())` call is then rejected as a call-produced test argument. Restrict namespace seeding to known framework modules; recognize custom fixtures through their `test` member/binding.
6. Resolving every array beneath a test-root call makes `test.each([{ retry: 2 }])(...)` treat domain table data as runner options. Exclude `.each`, `.for`, and `.extend` data/fixture arguments while retaining outer declaration tuple-spread handling.
7. Exact `d64f351c` marks `Object.freeze({ retry: 0, timeout: 1000 })` as mutated and rejects it. The live worktree already appears to address this; retain a green regression.

No other Gate 1 specification issue was found. Final closure still requires green CI at the eventual reviewed checkpoint.
