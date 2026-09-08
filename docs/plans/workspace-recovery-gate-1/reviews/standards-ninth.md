# Gate 1 standards review — `d64f351c6b1b46dc1375639fa69faf2c52b4d917`

**BLOCK — ADR-031 lines 33–35 requires rejecting blind retries across the required test surface.** Three ordinary configuration paths remain outside the scan:

1. `scripts/ci/check-test-policy.mjs:48-65` treats YAML as independent lines. A GitHub Actions folded scalar exits 0 because `vitest` and `--retry=2` occur on separate source lines even though YAML joins them into one command:
   ```yaml
   - run: >
       pnpm vitest run
       --retry=2
   ```
2. Lines 35–44 and 48–65 do not resolve runner `--config`. A package script `vitest run --config ./custom.ts` exits 0 when `custom.ts` contains `{ test: { retry: 2 } }`; the default inventory would exclude that nonconventional filename.
3. Lines 72–109 follow ESM imports/re-exports only. A supported `vitest.config.cjs` containing `module.exports = require("./shared-options.cjs")` exits 0 when the required file enables retry 2.

The shell backslash-continuation probe rejects correctly. Six policy regressions, five CI-script tests, and the 431-source/27-command scan pass but do not cover these paths.

Nonblocking possible **Divergent Change**: this 509-line module now parses JSON, YAML/shell text, TypeScript dependency graphs, test APIs, mock exceptions, and immutable Git baselines. The central enforcement purpose is coherent, but format-specific extractors would make these coverage rules easier to test.

Exact-candidate CI remains a separate pending closure condition.
