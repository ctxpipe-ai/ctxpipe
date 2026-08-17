# Memory harness live evals (Layer B)

Opt-in design for nightly checks that would drive a real host agent in a sandbox
and assert filesystem outcomes (candidates under `.ai/memory/events/`, promoted
Markdown).

**Not required for PR CI.** Layer A Vitest harness under `../harness/` is the
merge gate.

## Status

The **scenario YAML + prompt/classifier contract tests are live in CI**. The
TanStack AI Sandbox + `claudeCodeText` **runner is not wired yet**. Setting
`CTXPIPE_MEMORY_LIVE_EVAL=1` does **not** claim a green agent golden path — the
live runner test stays skipped until that integration lands.

## Scenario contract (CI)

```bash
pnpm --filter ctxpipe exec vitest run test/memory/evals
```

- Scenario YAML under `scenarios/` describes **seed files**, the agent **prompt**,
  and expected filesystem assertions.
- The prompt must classify as **empty** under `classifyText` (no CLASSIFIERS /
  FACT_PATTERNS hits). Ground truth belongs in `seed:` so `candidatesMin` cannot
  pass from UserPromptSubmit alone.

## Planned runner (not implemented)

When wired: provision a disposable workspace, install memory via the CLI,
materialize `seed`, invoke `claudeCodeText` (later Codex/OpenCode), then assert
files (`candidatesFromAgentActivity`, `lessonsContains`, etc.).

MCPJam is out of scope (wrong layer for Markdown + hooks memory).
