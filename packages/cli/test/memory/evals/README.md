# Memory harness live evals (Layer B)

Opt-in / nightly checks that drive a real host agent in a sandbox and assert
filesystem outcomes (candidates under `.ai/memory/events/`, promoted Markdown).

**Not required for PR CI.** Layer A Vitest harness under
`../harness/` is the merge gate.

## Enable

```bash
export CTXPIPE_MEMORY_LIVE_EVAL=1
# plus whatever secrets your sandbox provider needs
pnpm --filter ctxpipe exec vitest run test/memory/evals
```

## Design

- Scenario YAML under `scenarios/` describes the prompt and expected filesystem
  assertions.
- Runner (when enabled) provisions a disposable workspace, installs memory via
  the CLI, invokes `claudeCodeText` (later Codex/OpenCode), then asserts files.
- Until a golden path is green in CI with secrets, tests skip unless
  `CTXPIPE_MEMORY_LIVE_EVAL=1`.

MCPJam is out of scope (wrong layer for Markdown + hooks memory).
