/**
 * Pure parts of the answer eval (ADR-033 rung 3): MCP body parsing, heuristic
 * grading and report rendering. No network, no LLM — unit-tested so a broken
 * harness cannot masquerade as a bad graph.
 */

export type EvalQuestion = {
  id: string
  category: string
  question: string
  expected?: string
  expectedKinds?: string[]
  expectedUrls?: string[]
}

export type EvalJudgement = {
  correct: number
  grounded: number
  fakeStandard: boolean
  notes: string
}

export type EvalGrade = {
  /** Distinct http(s) URLs in the answer. */
  citations: number
  /** Citations that resolved (HEAD < 400, or 403 / 429 from rate-limited hosts). */
  groundedUrls: number
  /** Expected graph kinds the answer visibly reached (all hinted kinds when none expected). */
  kindsHit: string[]
  judge?: EvalJudgement
}

export type EvalResult = {
  target: string
  question: EvalQuestion
  answer: string
  ms: number
  grade: EvalGrade
  error?: string
}

const URL_PATTERN = /https?:\/\/[^\s<>()[\]"'`]+/g

/** Visible traces of each graph kind in prose; deliberately conservative. */
export const KIND_HINTS: Record<string, RegExp> = {
  PullRequest:
    /\bpull request\b|\bPR\b|github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i,
  Issue: /\b[A-Z][A-Z0-9]{1,9}-\d+\b|linear\.app\/[^\s]+\/issue\//,
  Decision: /\bADR[-\s]?\d+\b|\bdecision record\b/i,
  Thread: /slack\.com\/archives\//i,
  Team: /\bowned by\b|\bowner(?:s|ship)?\b|CODEOWNERS/i,
  File: /`[^`\s]+\/[^`\s]+\.[A-Za-z0-9]{1,12}`/,
}

/** Parse a streamable-HTTP MCP response body: plain JSON, or SSE `data:` lines. */
export function parseMcpBody(body: string): unknown[] {
  const trimmed = body.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : [parsed]
  }
  return trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()) as unknown)
}

type JsonRpcMessage = {
  result?: { content?: Array<{ type: string; text?: string }> }
  error?: { message?: string }
}

/** Text of the first `tools/call` result; throws on a JSON-RPC error or no text. */
export function extractToolText(messages: unknown[]): string {
  for (const message of messages as JsonRpcMessage[]) {
    if (message.error?.message) {
      throw new Error(`tools/call error: ${message.error.message}`)
    }
    const text = message.result?.content
      ?.filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
    if (text) return text
  }
  throw new Error("tools/call returned no text content")
}

export function extractCitationUrls(answer: string): string[] {
  return [...new Set(answer.match(URL_PATTERN) ?? [])].map((url) =>
    url.replace(/[.,;:!?)]+$/, ""),
  )
}

/**
 * Network-free grading. `resolvable` maps each citation URL to whether a HEAD
 * request succeeded; missing entries count as unresolved.
 */
export function gradeHeuristically(
  question: EvalQuestion,
  answer: string,
  resolvable: Record<string, boolean>,
): EvalGrade {
  const urls = extractCitationUrls(answer)
  const kindsHit = Object.entries(KIND_HINTS)
    .filter(([, pattern]) => pattern.test(answer))
    .map(([kind]) => kind)
  return {
    citations: urls.length,
    groundedUrls: urls.filter((url) => resolvable[url] === true).length,
    kindsHit: question.expectedKinds
      ? kindsHit.filter((kind) => question.expectedKinds?.includes(kind))
      : kindsHit,
  }
}

export function renderReport(
  results: EvalResult[],
  targets: ReadonlyArray<{ name: string }>,
): string {
  const lines: string[] = ["# Answer eval", ""]
  for (const target of targets) {
    const rows = results.filter((r) => r.target === target.name && !r.error)
    const errors = results.filter(
      (r) => r.target === target.name && r.error,
    ).length
    const avg = (pick: (r: EvalResult) => number) =>
      rows.length
        ? (rows.reduce((sum, r) => sum + pick(r), 0) / rows.length).toFixed(2)
        : "n/a"
    lines.push(`## ${target.name}`, "")
    lines.push(`- answered: ${rows.length}, errors: ${errors}`)
    lines.push(`- citations per answer: ${avg((r) => r.grade.citations)}`)
    lines.push(
      `- resolvable citations per answer: ${avg((r) => r.grade.groundedUrls)}`,
    )
    lines.push(
      `- expected kinds reached per answer: ${avg((r) => r.grade.kindsHit.length)}`,
    )
    if (rows.some((r) => r.grade.judge)) {
      lines.push(
        `- judge correctness (0-2): ${avg((r) => r.grade.judge?.correct ?? 0)}`,
      )
      lines.push(
        `- judge grounding (0-2): ${avg((r) => r.grade.judge?.grounded ?? 0)}`,
      )
      lines.push(
        `- answers presenting tickets as standards: ${rows.filter((r) => r.grade.judge?.fakeStandard).length}`,
      )
    }
    lines.push(`- mean latency ms: ${avg((r) => r.ms)}`, "")
  }
  lines.push("## Per question", "")
  lines.push(
    "| id | category | target | citations | grounded | kinds | correct | latency ms | error |",
  )
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
  for (const r of results) {
    lines.push(
      `| ${r.question.id} | ${r.question.category} | ${r.target} | ${r.grade.citations} | ${r.grade.groundedUrls} | ${r.grade.kindsHit.join(" ") || "-"} | ${r.grade.judge?.correct ?? "-"} | ${r.ms} | ${r.error ?? ""} |`,
    )
  }
  lines.push("", "## Answers", "")
  for (const r of results) {
    lines.push(
      `### ${r.question.id} · ${r.target}`,
      "",
      r.error ? `_error: ${r.error}_` : r.answer,
      "",
    )
  }
  return lines.join("\n")
}

export type McpTarget = { name: string; url: string }

/** Minimal fetch signature so tests can inject a fake without Bun's extra members. */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

/**
 * Streamable-HTTP MCP handshake against a ctxpipe deployment, then one
 * `ctx_advisor` call. `fetchImpl` is injectable so the sequence is testable.
 */
export async function callCtxAdvisor(
  target: McpTarget,
  apiKey: string,
  question: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-11-25",
    "x-api-key": apiKey,
  }
  const init = await fetchImpl(target.url, {
    method: "POST",
    headers: { ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "ctxpipe-answer-eval", version: "1" },
      },
    }),
  })
  if (!init.ok) throw new Error(`initialize failed: HTTP ${init.status}`)
  const session = init.headers.get("mcp-session-id")
  if (session) headers["mcp-session-id"] = session

  await fetchImpl(target.url, {
    method: "POST",
    headers: { ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  })

  const response = await fetchImpl(target.url, {
    method: "POST",
    headers: { ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "ctx_advisor", arguments: { prompt: question } },
    }),
  })
  if (!response.ok)
    throw new Error(`tools/call failed: HTTP ${response.status}`)
  return extractToolText(parseMcpBody(await response.text()))
}
