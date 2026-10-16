import type { IngestStepUsage } from "./ingest-shard-runtime.js"

/*
 * The model usage of one ingest model step. `opencode run --format json`
 * writes one JSON event on each line. Each model call ends with a
 * `step_finish` event; its part holds the tokens and the cost of that call.
 * The command keeps only those lines on stdout, because the other events
 * (tool output, text) can be large.
 */

/** The start of each `step_finish` line (`JSON.stringify({ type, … })`). */
const STEP_FINISH = '{"type":"step_finish"'

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * The shell command of one model step: `opencode run` with JSON events, and
 * only the `step_finish` lines on stdout. The command exits with the exit
 * code of `opencode run`, not of the filter.
 */
export function ingestModelRunCommand(input: {
  prompt: string
  model?: string
}): string {
  const run = `opencode run --format json${input.model ? ` --model ${quote(input.model)}` : ""} ${quote(input.prompt)}`
  // POSIX sh has no pipefail: fd 3 carries the exit code of `opencode run`
  // out of the pipe, and fd 4 carries the filtered lines to stdout.
  return `exec 4>&1; code=$( { { ${run}; echo $? >&3; } | { grep -F ${quote(STEP_FINISH)} >&4; true; }; } 3>&1 ); exit "$code"`
}

/** A number, or 0. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0
}

/**
 * The usage in the stdout of `ingestModelRunCommand`, or undefined when no
 * line is a `step_finish` event. Input tokens include the cache reads and
 * writes, and output tokens include the reasoning tokens, so that the
 * estimate at the committed prices is not low. `costUsd` is set only when
 * each call reports a cost above 0: OpenCode reports 0 for a model that has
 * no price in its config.
 */
export function parseOpenCodeUsage(
  stdout: string,
): IngestStepUsage | undefined {
  let found = false
  let inputTokens = 0
  let outputTokens = 0
  let costUsd = 0
  let costKnown = true
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(STEP_FINISH)) continue
    let event: { part?: { cost?: unknown; tokens?: Record<string, unknown> } }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const tokens = event.part?.tokens
    if (!tokens || typeof tokens !== "object") continue
    found = true
    const cache = (tokens.cache ?? {}) as Record<string, unknown>
    inputTokens += count(tokens.input) + count(cache.read) + count(cache.write)
    outputTokens += count(tokens.output) + count(tokens.reasoning)
    const cost = count(event.part?.cost)
    if (cost > 0) costUsd += cost
    else costKnown = false
  }
  if (!found) return undefined
  return {
    inputTokens,
    outputTokens,
    ...(costKnown ? { costUsd } : {}),
  }
}
