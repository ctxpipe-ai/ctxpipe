/**
 * Live decision-gate evaluation: sends the labelled prompts in
 * `evals/decision-gate/` to a deployed `ctx_advisor` and checks whether each
 * answer carries the "**Human decision needed**" block when it should. Unlike
 * `decisionGate.eval.test.ts`, this exercises real retrieval (semantic + BM25),
 * so it measures what the gate sees in production. Cases that inject or
 * exclude candidates are skipped: a live advisor cannot fake its retrieval.
 *
 * Usage (apps/backend; `CTXPIPE_API_KEY` is an organization MCP API key for the
 * org whose decisions are in decisions.json, i.e. ctx-tev):
 *   bun run src/scripts/decisionGateLiveEval.ts --url https://<pr-preview-host>/mcp [--out evals/decision-gate/results/<name>.json]
 */
import { writeFileSync } from "node:fs"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  type DecisionGateCase,
  decisionGateCasesExist,
  readDecisionGateCases,
} from "../graphs/conversationGraph/decisionGateCases.js"

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

async function main(argv: string[]): Promise<void> {
  const url = flag(argv, "--url")
  const apiKey = process.env.CTXPIPE_API_KEY
  if (!url || !apiKey) {
    throw new Error("Pass --url <mcp endpoint> and set CTXPIPE_API_KEY")
  }
  const cases = ["scenarios.json", "held-out.json", "held-out-2.json"]
    .filter(decisionGateCasesExist)
    .flatMap(readDecisionGateCases)
    .filter((c) => !c.inject?.length && !c.exclude?.length)

  const client = new Client({ name: "decision-gate-eval", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { "x-api-key": apiKey } },
    }),
  )

  const results: Array<
    DecisionGateCase & { answer: string; flagged: boolean }
  > = []
  for (const c of cases) {
    const response = CallToolResultSchema.parse(
      await client.callTool({
        name: "ctx_advisor",
        arguments: {
          prompt: c.prompt,
          conversationId: `decision-gate-${c.id}`,
        },
      }),
    )
    const answer = response.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
    const flagged = answer.includes("**Human decision needed**")
    results.push({ ...c, answer, flagged })
    process.stdout.write(
      `${flagged === c.escalate ? "pass" : "FAIL"}  ${c.id.padEnd(40)} expected ${c.escalate ? "escalate" : "none"}, got ${flagged ? "escalate" : "none"}\n`,
    )
  }
  await client.close()

  const tp = results.filter((r) => r.escalate && r.flagged).length
  const fp = results.filter((r) => !r.escalate && r.flagged).length
  const fn = results.filter((r) => r.escalate && !r.flagged).length
  process.stdout.write(
    `\n${results.length - fp - fn}/${results.length} correct; precision ${(tp / Math.max(tp + fp, 1)).toFixed(2)}, recall ${(tp / Math.max(tp + fn, 1)).toFixed(2)}\n`,
  )
  const out = flag(argv, "--out")
  if (out) writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`)
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exit(1)
  })
}
