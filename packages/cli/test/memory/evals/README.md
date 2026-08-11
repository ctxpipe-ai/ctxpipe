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
# or: pnpm --filter ctxpipe test:memory-live
```

## Design

- Scenario YAML under `scenarios/` describes **seed files**, the agent **prompt**,
  and expected filesystem assertions.
- The prompt must classify as **empty** under `classifyText` (no CLASSIFIERS /
  FACT_PATTERNS hits — avoid `do not` / `never` / `lessons-learned` / port facts).
  Ground truth belongs in `seed:` so `candidatesMin` cannot pass from
  UserPromptSubmit alone. Layer B unit tests call the real classifier on the
  YAML prompt.
- Runner (when enabled) provisions a disposable workspace, installs memory via
  the CLI, materializes `seed`, invokes `claudeCodeText` (later Codex/OpenCode),
  then asserts files (`candidatesFromAgentActivity`, `lessonsContains`, etc.).
- Until a golden path is green with secrets, tests skip unless
  `CTXPIPE_MEMORY_LIVE_EVAL=1` (and fail closed if that flag is set without a
  wired runner).

MCPJam is out of scope (wrong layer for Markdown + hooks memory).
