import type { IngestStepUsage } from "./ingest-shard-runtime.js"

/*
 * The model usage of one ingest model step. `opencode run --format json`
 * writes one JSON event on each line. Each model call ends with a
 * `step_finish` event; its part holds the tokens and the cost of that call.
 * The command keeps only those lines and the `error` events on stdout,
 * because the other events (tool output, text) can be large.
 */

/** The start of each `step_finish` line (`JSON.stringify({ type, … })`). */
const STEP_FINISH = '{"type":"step_finish"'

/** The start of each `error` line: OpenCode stopped the session on an error. */
const ERROR_EVENT = '{"type":"error"'

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * The shell command of one model step: `opencode run` with JSON events, and
 * only the `step_finish` and `error` lines on stdout. The command exits with the exit
 * code of `opencode run`, not of the filter.
 */
export function ingestModelRunCommand(input: {
  prompt: string
  model?: string
}): string {
  const run = `opencode run --format json${input.model ? ` --model ${quote(input.model)}` : ""} ${quote(input.prompt)}`
  // POSIX sh has no pipefail: fd 3 carries the exit code of `opencode run`
  // out of the pipe, and fd 4 carries the filtered lines to stdout.
  return `exec 4>&1; code=$( { { ${run}; echo $? >&3; } | { grep -F -e ${quote(STEP_FINISH)} -e ${quote(ERROR_EVENT)} >&4; true; }; } 3>&1 ); exit "$code"`
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

/**
 * The safe summary of the last `error` event in the stdout of
 * `ingestModelRunCommand`: the error name (a code identifier, for example
 * `APIError`) and the HTTP status. The message is not in it, because it can
 * hold source text.
 */
export function parseOpenCodeError(
  stdout: string,
): { name: string; statusCode?: number } | undefined {
  let found: { name: string; statusCode?: number } | undefined
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(ERROR_EVENT)) continue
    let event: { error?: { name?: unknown; data?: { statusCode?: unknown } } }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const name = event.error?.name
    const status = event.error?.data?.statusCode
    found = {
      name:
        typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)
          ? name
          : "unknown",
      ...(Number.isInteger(status) &&
      (status as number) >= 100 &&
      (status as number) <= 599
        ? { statusCode: status as number }
        : {}),
    }
  }
  return found
}

/** The fixed class of a failed step command, for the log. */
export type IngestFailureHint =
  | "ENOTFOUND"
  | "ECONNREFUSED"
  | "ECONNRESET"
  | "ETIMEDOUT"
  | "proxy"
  | "connect"
  | "config"
  | "other"

/**
 * Classify the output of a failed step command (its stderr and the messages
 * of its `error` events). The log gets only the class, never the text,
 * because the text can hold source text.
 */
export function ingestFailureHint(output: string): IngestFailureHint {
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(output)) return "ENOTFOUND"
  if (/ECONNREFUSED|Connection refused/i.test(output)) return "ECONNREFUSED"
  if (/ECONNRESET|socket hang up/i.test(output)) return "ECONNRESET"
  if (/ETIMEDOUT|timed? ?out/i.test(output)) return "ETIMEDOUT"
  if (/proxy|\b407\b/i.test(output)) return "proxy"
  if (/Unable to connect|Cannot connect/i.test(output)) return "connect"
  if (/config|ProviderModelNotFound|ProviderInit/i.test(output)) return "config"
  return "other"
}

/**
 * The distinct ERROR and WARN messages of an OpenCode log file
 * (`level=WARN … message="server unavailable" key=…`), at most 5. A message
 * that is not a short plain phrase (a path, a URL, quoted text) is left out:
 * only the fixed messages of OpenCode's code get into the log.
 */
export function parseOpenCodeLogMessages(log: string): string[] {
  const found = new Set<string>()
  for (const line of log.split("\n")) {
    const match =
      /\blevel=(?:ERROR|WARN)\b.*?\bmessage=(?:"([^"]*)"|(\S+))/.exec(line)
    const message = match?.[1] ?? match?.[2]
    if (message && /^[A-Za-z][A-Za-z0-9 .,:_-]{0,79}$/.test(message))
      found.add(message)
    if (found.size === 5) break
  }
  return [...found]
}
