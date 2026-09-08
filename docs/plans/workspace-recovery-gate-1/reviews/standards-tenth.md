# Gate 1 standards review — `0176f8a6097c2cf5e15b472b31db7d02b852c389`

**BLOCK — ADR-031 lines 33–35 requires rejecting blind test retries across the required command surface.** `scripts/ci/test-configuration.mjs:51-59` only inspects a retry flag when the same line contains literal `vitest`/`playwright`, or when `test` immediately follows `pnpm`/`npm`/`bun`. Common monorepo forwarding forms therefore exit 0 with active retries:

```json
{"scripts":{"test:backend":"pnpm --filter @ctxpipe/backend test -- --retry=2"}}
```

```json
{"scripts":{"test":"turbo run test -- --retry=2"}}
```

The filtered pnpm form matches this repository's documented/root-script command convention. The same pnpm command in parsed workflow YAML also exits 0. Detect retry flags before narrowing runner syntax, or parse package-manager/Turbo forwarding forms.

Nonblocking correctness judgment: `scripts/ci/check-test-policy.mjs:321-330` rejects split zero argv (`"--retry", "0"`) although command parsing accepts `--retry 0`; `--retry=0` remains an available unambiguous form.

The earlier YAML folding, custom `--config`, ESM/re-export/CJS graph, call-return options, wrapper mutation, tuple-data, and namespace findings are fixed. Five public script tests and the exact 433-source/27-command scan pass locally. Extraction into `test-configuration.mjs` removes the prior Divergent Change concern. `bec0c492` has 13 green CI jobs; exact-candidate CI remains separate.
