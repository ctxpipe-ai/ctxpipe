/**
 * Run the MCPJam eval suite against a seeded ctxpipe server (CTX-574).
 *
 *   bun evals/mcp/run.ts --models anthropic/<model>,openai/<model> --out results.json
 *
 * Connection settings come from the environment, because they differ for each
 * target: MCP_EVAL_URL (the `/mcp` URL), MCP_EVAL_API_KEY (a personal API key
 * with both fixture orgs), MCP_EVAL_RUN (the run name of the seed, see
 * README.md). Each model needs `<PROVIDER>_API_KEY`, for example
 * ANTHROPIC_API_KEY.
 *
 * The tool set of the server picks the mode (see `detectToolSet`). Exit code 0:
 * the gate passed. 1: the gate failed. 2: bad setup (no seed, bad tool set).
 */
import { readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { EvalTest, HostRunner, MCPClientManager } from "@mcpjam/sdk"
import { type EvalCase, evalCases } from "./cases.js"
import {
  type CaseContext,
  checkCase,
  detectToolSet,
  type ToolSetMode,
  transcriptFromMessages,
} from "./check.js"
import {
  type Baseline,
  baselineFromRun,
  evaluateGate,
  type RunResult,
} from "./gate.js"

const baselinePath = new URL("./baseline.json", import.meta.url)

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Set ${name}. See apps/backend/evals/mcp/README.md.`)
    process.exit(2)
  }
  return value
}

async function main() {
  process.env.MCPJAM_TELEMETRY_DISABLED = "1"
  const { values } = parseArgs({
    options: {
      models: { type: "string" },
      iterations: { type: "string", default: "3" },
      concurrency: { type: "string", default: "3" },
      cases: { type: "string" },
      out: { type: "string" },
      "update-baseline": { type: "boolean", default: false },
    },
  })
  const models = (values.models ?? "").split(",").filter(Boolean)
  if (models.length === 0) {
    console.error(
      "Pass --models provider/model[,provider/model]. Use at least two.",
    )
    process.exit(2)
  }
  const iterations = Number(values.iterations)
  const run = required("MCP_EVAL_RUN")
  const orgs = {
    harbor: `mcp-eval-${run}-harbor`,
    meadow: `mcp-eval-${run}-meadow`,
  }
  const url = new URL(required("MCP_EVAL_URL"))

  const manager = new MCPClientManager()
  await manager.connectToServer("ctxpipe", {
    url: url.toString(),
    requestInit: { headers: { "x-api-key": required("MCP_EVAL_API_KEY") } },
  })
  try {
    const { tools } = await manager.listTools("ctxpipe")
    let mode: ToolSetMode
    try {
      mode = detectToolSet(tools.map((tool) => tool.name))
    } catch (error) {
      console.error(String(error))
      process.exit(2)
    }
    const selected =
      values.cases?.split(",") ?? evalCases.map((item) => item.id)
    const active = evalCases.filter((item) => selected.includes(item.id))
    const instructions = manager.getInitializationInfo("ctxpipe")?.instructions
    const context: CaseContext = { orgs, mode }
    console.log(
      `Mode ${mode}: ${active.length} cases, ${models.length} models, ${iterations} iterations.`,
    )

    const result: RunResult = { mode, models: {} }
    const details: Record<string, Record<string, string[]>> = {}
    for (const model of models) {
      const provider = model.split("/")[0]?.toUpperCase().replace(/\W/g, "_")
      const apiKey = required(`${provider}_API_KEY`)
      const scores: RunResult["models"][string] = {}
      result.models[model] = scores
      const modelDetails: Record<string, string[]> = {}
      details[model] = modelDetails
      for (const evalCase of active) {
        const failures: string[] = []
        scores[evalCase.id] = { passes: 0, iterations: 0 }
        const runner = new HostRunner({
          tools: await manager.getToolsForAiSdk(["ctxpipe"]),
          model,
          apiKey,
          maxSteps: 12,
          systemPrompt: systemPrompt(evalCase, instructions),
        })
        const test = new EvalTest({
          id: `mcp_${evalCase.id.replace(/-/g, "_")}`,
          name: evalCase.name,
          test: async (executor) => {
            const prompt = await executor.run(evalCase.prompt, {
              timeout: { totalMs: 120_000 },
            })
            const outcome = checkCase(
              evalCase,
              transcriptFromMessages(prompt.getMessages()),
              context,
            )
            const score = scores[evalCase.id]
            if (score) {
              score.iterations += 1
              if (outcome.passed) score.passes += 1
            }
            failures.push(...outcome.failures)
            return outcome.passed
          },
        })
        await test.run(runner, {
          iterations,
          concurrency: Number(values.concurrency),
          timeoutMs: 180_000,
        })
        const unique = [...new Set(failures)]
        modelDetails[evalCase.id] = unique
        const score = scores[evalCase.id]
        console.log(
          `${model} ${evalCase.id}: ${score?.passes}/${score?.iterations}`,
        )
        for (const failure of unique) console.log(`  - ${failure}`)
      }
    }

    const baseline = JSON.parse(
      await readFile(baselinePath, "utf8"),
    ) as Baseline
    const report = evaluateGate(
      result,
      baseline[mode],
      active.map((item) => item.id),
    )
    for (const note of report.notes) console.log(`note: ${note}`)
    for (const failure of report.failures) console.error(`FAIL: ${failure}`)
    if (values.out)
      await writeFile(
        values.out,
        JSON.stringify({ result, details, report }, null, 2),
      )
    if (values["update-baseline"]) {
      baseline[mode] = baselineFromRun(result, new Date().toISOString())
      await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`)
      console.log(`Baseline for ${mode} written. Commit baseline.json.`)
    }
    process.exitCode = report.passed ? 0 : 1
  } finally {
    await manager.disconnectServer("ctxpipe")
  }
}

/** What a coding agent host adds: the working repository and the server instructions. */
function systemPrompt(
  evalCase: EvalCase,
  instructions: string | undefined,
): string {
  return [
    "You are a coding agent. Use the connected ctxpipe tools when they help.",
    evalCase.workingRepository
      ? `Your working repository has the git remote ${evalCase.workingRepository}.`
      : "You are not inside a git repository.",
    instructions ? `Server instructions:\n${instructions}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

await main()
