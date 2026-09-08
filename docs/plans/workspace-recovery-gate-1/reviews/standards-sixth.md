# Gate 1 standards review — `6d180ca8407d91683203e8bc86080786c50022d7`

**BLOCK — ADR-031 lines 33–34 requires rejecting blind test retries.** The new compiler binding lookup fixes lexical shadowing and template keys, but `scripts/ci/check-test-policy.mjs:56-63,170-205` resolves a symbol only to its declaration initializer and ignores writes to mutable bindings. Both of these active two-retry tests exit 0:

```ts
let retry = 0
retry = 2
test("proof", { retry }, () => {})
```

```ts
let options = { retry: 0 }
options = { retry: 2 }
test("proof", options, () => {})
```

The regression inventory at `scripts/tests/ci-test-policy.test.mjs:50-76` covers lexical shadowing and `const` zero values, not assignment. Treat a mutable or multiply-written retry/options binding conservatively, or resolve the reaching assignment. This remains possible **Primitive Obsession**: the code now preserves symbol identity but reduces a binding's value to one initializer rather than its write history.

The five CI-script tests and 431-file scan pass locally. Retained `ci-05a3c6e4-complete.json` records all 13 prior-checkpoint jobs green, including six production images and codesearch; `6d180ca8` CI remains a separate pending closure condition. No other documented-standard blocker found.
