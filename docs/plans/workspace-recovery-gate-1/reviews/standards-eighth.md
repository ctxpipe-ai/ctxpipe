# Gate 1 standards review — `bec0c492d051cd1d7a004f3d8b230f4e138de445`

**BLOCK — ADR-031 lines 33–35 requires rejecting blind retries and selection/expected-failure options.** `scripts/ci/check-test-policy.mjs:211-221` marks objects passed into arbitrary calls as escaped, but `markOptions` at lines 227–245 stops when the test option expression or its `const` initializer is a call. It never inspects the call's returned construction. These practical active-retry forms both exit 0:

```ts
const options = Object.assign({}, { retry: 2 })
test("proof", options, () => {})
```

```ts
test("proof", Object.assign({}, { retry: 2 }), () => {})
```

`const options = Object.freeze({ retry: 2 })` also passes. The four regressions at `scripts/tests/ci-test-policy.test.mjs:30-33` cover mutating an existing object, not call-return option construction. Conservatively reject unresolved call expressions used as test options, or model approved immutable wrappers and inspect their object arguments. The same gap applies to `fails/skip/only/todo`.

The updated baseline accurately distinguishes prior `05a3c6e4` green CI from pending exact-candidate CI. Five script tests and the 431-file scan pass, but miss this escape. No other documented-standard blocker found.
