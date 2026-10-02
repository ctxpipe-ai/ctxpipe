/**
 * Answer-level evaluation of `ctx_advisor` on questions answered by the ctxpipe
 * org's own ADRs (`evals/advisor/questions.json`). Scoring is deterministic:
 * the answer must cite every expected ADR, state every expected term (`a|b`
 * means either), and put each supersession pair `[successor, superseded]` on
 * one line.
 *
 * Usage (apps/backend; `CTXPIPE_API_KEY` is an organization MCP API key):
 *   bun run src/scripts/advisorEval.ts --url https://app.ctxpipe.ai/mcp [--out evals/advisor/results/<name>.json]
 *   bun run src/scripts/advisorEval.ts --score evals/advisor/results/<name>.json   (re-score saved answers)
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

export type Expectation = {
  adrs?: number[]
  terms?: string[]
  pairs?: Array<[number, number]>
}

export type Question = {
  id: string
  kind: "lookup" | "aggregation"
  prompt: string
  expect: Expectation
}

const ADR_MENTION = /\bADR[-\s]?0*(\d{1,4})\b/gi

function adrsIn(text: string): number[] {
  return [...new Set([...text.matchAll(ADR_MENTION)].map((m) => Number(m[1])))]
}

export function scoreAnswer(answer: string, expect: Expectation) {
  const cited = adrsIn(answer)
  const lower = answer.toLowerCase()
  const lines = answer.split("\n").map(adrsIn)
  const missingAdrs = (expect.adrs ?? []).filter((adr) => !cited.includes(adr))
  const missingTerms = (expect.terms ?? []).filter(
    (term) =>
      !term.split("|").some((option) => lower.includes(option.toLowerCase())),
  )
  const missingPairs = (expect.pairs ?? [])
    .filter(
      ([a, b]) => !lines.some((line) => line.includes(a) && line.includes(b)),
    )
    .map(([a, b]) => `ADR-${a}/ADR-${b}`)
  return {
    pass:
      missingAdrs.length === 0 &&
      missingTerms.length === 0 &&
      missingPairs.length === 0,
    citedAdrs: cited.sort((a, b) => a - b),
    missingAdrs,
    missingTerms,
    missingPairs,
  }
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function report(id: string, score: ReturnType<typeof scoreAnswer>): void {
  const missing = [
    ...score.missingAdrs.map((adr) => `ADR-${adr}`),
    ...score.missingTerms,
    ...score.missingPairs,
  ]
  process.stdout.write(
    `${score.pass ? "pass" : "FAIL"}  ${id.padEnd(16)} cited ${score.citedAdrs.join(",")}${missing.length ? `  missing ${missing.join(", ")}` : ""}\n`,
  )
}

async function main(argv: string[]): Promise<void> {
  const here = fileURLToPath(new URL(".", import.meta.url))
  const questions = JSON.parse(
    readFileSync(resolve(here, "../../evals/advisor/questions.json"), "utf8"),
  ) as Question[]

  const saved = flag(argv, "--score")
  if (saved) {
    const { results } = JSON.parse(readFileSync(saved, "utf8")) as {
      results: Array<{ id: string; answer: string }>
    }
    let passed = 0
    for (const question of questions) {
      const answer = results.find((r) => r.id === question.id)?.answer ?? ""
      const score = scoreAnswer(answer, question.expect)
      if (score.pass) passed++
      report(question.id, score)
    }
    process.stdout.write(`${passed}/${questions.length} pass\n`)
    return
  }

  const url = flag(argv, "--url")
  const apiKey = process.env.CTXPIPE_API_KEY
  if (!url || !apiKey) {
    throw new Error("--url and CTXPIPE_API_KEY are required")
  }

  const client = new Client({ name: "advisor-eval", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { "x-api-key": apiKey } },
    }),
  )

  const runId = new Date().toISOString()
  const results = []
  for (const question of questions) {
    const response = await client.callTool(
      {
        name: "ctx_advisor",
        arguments: {
          prompt: question.prompt,
          currentProjectName: "ctxpipe",
          conversationId: `advisor-eval-${runId}-${question.id}`,
        },
      },
      undefined,
      { timeout: 300_000 },
    )
    const answer = (response.content as Array<{ type: string; text?: string }>)
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
    const score = scoreAnswer(answer, question.expect)
    results.push({ id: question.id, kind: question.kind, ...score, answer })
    report(question.id, score)
  }
  await client.close()

  const passed = results.filter((r) => r.pass).length
  process.stdout.write(`${passed}/${results.length} pass\n`)
  const out = flag(argv, "--out")
  if (out)
    writeFileSync(out, `${JSON.stringify({ runId, url, results }, null, 2)}\n`)
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  })
}
