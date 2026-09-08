# Gate 1 standards review — fourth interim

Reviewed `29a082aef00e603ddb79e38671dda83abc81e124...b890dccc52aebc3513e1ca7e1fa91e4cf5304749` and rechecked the policy against ADR-031.

**Standards FAIL — one code blocker.**

The new alias propagation and named/spread option resolution work, but retry rejection still visits only `ts.isPropertyAssignment` (`scripts/ci/check-test-policy.mjs:277-298`). Object shorthand is a distinct `ShorthandPropertyAssignment`, so both ordinary forms below exit 0:

```ts
const retry = 2
test("proof", { retry }, () => {})

export default defineConfig({ test: { retry } })
```

`const retries = 2; const base = { retries }; const options = { ...base }; test("proof", options, fn)` also passes. These directly violate ADR-031’s “Reject … blind test retries” rule (`.ai/memory/decisions/ADR-031-required-recovery-ci.md:33-36`). Add shorthand-property handling, resolving its identifier initializer to distinguish positive values from `0`/`false`, plus public red-green cases for inline, named/spread, and config forms.

The five Node 22 script tests and 431-file scan pass, but their fixtures do not cover this syntax. CI remains a separate pending gate condition.
