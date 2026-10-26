/**
 * Run the MCPJam eval suite against a seeded ctxpipe server (CTX-574).
 *
 *   bun evals/mcp/run.ts --url http://localhost:3000/mcp --seed seed.json \
 *     --models anthropic/<model>,openai/<model> --out results.json
 *
 * `--seed` is the JSON file that `run-seed.ts ci` writes: the run name, the
 * user id, the remotes file, and a personal API key for the two fixture
 * orgs. Every model runs through OpenRouter with MODEL_PROVIDER_API_KEY
 * (base URL: MODEL_PROVIDER_URL, default https://openrouter.ai/api/v1).
 * A case with `cursorFrom` moves the Workspace to its second projection with
 * `run-seed.ts advance`, so the backend environment (DATABASE_URL and the
 * other store settings) must be set too. Run each seed once.
 *
 * `--out` also records, for each model and case, the time, the input and
 * output tokens, and the cost in USD (from the OpenRouter price list) of the
 * iterations. It records no prompt or answer text.
 *
 * Exit code 0: the gate passed. 1: the gate failed. 2: bad setup.
 */
import { spawnSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"

import { EvalTest, HostRunner, MCPClientManager } from "@mcpjam/sdk"
import { z } from "zod"

import { type EvalCase, evalCases } from "./cases.js"
import {
  casePrompt,
  checkCase,
  requireReadTools,
  resolveOrgArgs,
  transcriptFromMessages,
} from "./check.js"
import {
  type Baseline,
  baselineFromRun,
  evaluateGate,
  gateThresholds,
  type RunResult,
} from "./gate.js"
import {
  openRouterClient,
  openRouterModelId,
  openRouterPrices,
  usageCost,
} from "./models.js"

const baselinePath = new URL("./baseline.json", import.meta.url)

function setupError(message: string): never {
  console.error(`${message} See apps/backend/evals/mcp/README.md.`)
  process.exit(2)
}

async function main() {
  process.env.MCPJAM_TELEMETRY_DISABLED = "1"
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      seed: { type: "string" },
      models: { type: "string" },
      iterations: { type: "string", default: "3" },
      concurrency: { type: "string", default: "3" },
      cases: { type: "string" },
      out: { type: "string" },
      "update-baseline": { type: "boolean", default: false },
    },
  })
  const models = [...new Set((values.models ?? "").split(",").filter(Boolean))]
  if (models.length < gateThresholds.minModels)
    setupError(
      `Pass --models provider/model,provider/model with at least ${gateThresholds.minModels} models.`,
    )
  const iterations = Number(values.iterations)
  if (!Number.isInteger(iterations) || iterations < 1)
    setupError("Pass --iterations as a positive integer.")
  if (!values.url || !values.seed) setupError("Pass --url and --seed.")
  const seed = z
    .object({
      run: z.string().min(1),
      userId: z.string().min(1),
      remotes: z.string().min(1),
      apiKey: z.string().min(1),
    })
    .parse(JSON.parse(await readFile(values.seed, "utf8")))
  const orgs = {
    harbor: `mcp-eval-${seed.run}-harbor`,
    meadow: `mcp-eval-${seed.run}-meadow`,
  }
  const clients = models.map((model) => {
    try {
      return { model, ...openRouterClient(model, process.env) }
    } catch (error) {
      return setupError(error instanceof Error ? error.message : String(error))
    }
  })

  const manager = new MCPClientManager()
  await manager.connectToServer("ctxpipe", {
    url: values.url,
    requestInit: { headers: { "x-api-key": seed.apiKey } },
  })
  try {
    const { tools } = await manager.listTools("ctxpipe")
    try {
      requireReadTools(tools.map((tool) => tool.name))
    } catch (error) {
      setupError(String(error))
    }
    const selected =
      values.cases?.split(",") ?? evalCases.map((item) => item.id)
    // A case with `cursorFrom` runs last, after the Workspace moves.
    const active = evalCases
      .filter((item) => selected.includes(item.id))
      .sort((a, b) => Number(!!a.cursorFrom) - Number(!!b.cursorFrom))
    const cursors = new Map<string, string>()
    for (const item of active) {
      if (!item.cursorFrom) continue
      const page = (await manager.executeTool(
        "ctxpipe",
        "search_knowledge",
        resolveOrgArgs(item.cursorFrom, orgs),
      )) as { structuredContent?: { cursor?: unknown } }
      const cursor = page.structuredContent?.cursor
      if (typeof cursor !== "string")
        setupError(`Case ${item.id}: search_knowledge returned no cursor.`)
      cursors.set(item.id, cursor)
    }
    const instructions = manager.getInitializationInfo("ctxpipe")?.instructions
    console.log(
      `${active.length} cases, ${models.length} models, ${iterations} iterations.`,
    )

    const result: RunResult = {
      iterations,
      passes: Object.fromEntries(models.map((model) => [model, {}])),
    }
    const details: Record<string, Record<string, string[]>> = {}
    const usage: Record<string, Record<string, CaseUsage>> = {}
    let advanced = false
    for (const evalCase of active) {
      if (evalCase.cursorFrom && !advanced) {
        advanceWorkspace(seed)
        advanced = true
      }
      const prompt = casePrompt(evalCase, cursors.get(evalCase.id))
      for (const { model, apiKey, sdkModel, customProviders } of clients) {
        const passes = result.passes[model] ?? {}
        passes[evalCase.id] = 0
        const used: CaseUsage = {
          durationMs: 0,
          inputTokens: 0,
          outputTokens: 0,
        }
        usage[model] = { ...usage[model], [evalCase.id]: used }
        const failures: string[] = []
        const runner = new HostRunner({
          tools: await manager.getToolsForAiSdk(["ctxpipe"]),
          model: sdkModel,
          apiKey,
          customProviders,
          maxSteps: 12,
          systemPrompt: systemPrompt(evalCase, instructions),
        })
        const test = new EvalTest({
          id: `mcp_${evalCase.id.replace(/-/g, "_")}`,
          name: evalCase.name,
          test: async (executor) => {
            const run = await executor.run(prompt, {
              timeout: { totalMs: 120_000 },
            })
            used.inputTokens += run.inputTokens()
            used.outputTokens += run.outputTokens()
            const outcome = checkCase(
              evalCase,
              transcriptFromMessages(run.getMessages()),
              { orgs },
            )
            if (outcome.passed)
              passes[evalCase.id] = (passes[evalCase.id] ?? 0) + 1
            failures.push(...outcome.failures)
            return outcome.passed
          },
        })
        const started = performance.now()
        try {
          await test.run(runner, {
            iterations,
            concurrency: Number(values.concurrency),
            timeoutMs: 180_000,
          })
        } catch (error) {
          // Iterations that did not pass count as failures (the gate divides
          // by the requested iterations).
          failures.push(`run failed: ${String(error)}`)
        }
        used.durationMs = Math.round(performance.now() - started)
        const unique = [...new Set(failures)]
        details[model] = { ...details[model], [evalCase.id]: unique }
        console.log(
          `${model} ${evalCase.id}: ${passes[evalCase.id]}/${iterations}`,
        )
        for (const failure of unique) console.log(`  - ${failure}`)
      }
    }

    const ids = active.map((item) => item.id)
    const baseline = JSON.parse(
      await readFile(baselinePath, "utf8"),
    ) as Baseline
    const report = evaluateGate(result, baseline, ids)
    const prices = await openRouterPrices(
      process.env.MODEL_PROVIDER_URL || "https://openrouter.ai/api/v1",
      models.map(openRouterModelId),
    )
    for (const model of models)
      for (const used of Object.values(usage[model] ?? {})) {
        const cost = usageCost(used, prices.get(openRouterModelId(model)))
        if (cost !== undefined) used.costUsd = cost
      }
    for (const note of report.notes) console.log(`note: ${note}`)
    for (const failure of report.failures) console.error(`FAIL: ${failure}`)
    if (values.out)
      await writeFile(
        values.out,
        JSON.stringify(
          {
            result,
            rates: baselineFromRun(result, ids, new Date().toISOString()),
            details,
            usage,
            report,
          },
          null,
          2,
        ),
      )
    if (values["update-baseline"]) {
      const recorded = baselineFromRun(result, ids, new Date().toISOString())
      await writeFile(baselinePath, `${JSON.stringify(recorded, null, 2)}\n`)
      console.log("Baseline written. Commit baseline.json.")
    }
    process.exitCode = report.passed ? 0 : 1
  } finally {
    await manager.disconnectServer("ctxpipe")
  }
}

/** The time, tokens and cost of the iterations of one case for one model. */
type CaseUsage = {
  durationMs: number
  inputTokens: number
  outputTokens: number
  costUsd?: number
}

/** Move the Harbor `payments` Workspace to its second projection (P4-1). */
function advanceWorkspace(seed: {
  run: string
  userId: string
  remotes: string
}) {
  const advance = spawnSync(
    "bun",
    [
      new URL("./run-seed.ts", import.meta.url).pathname,
      "advance",
      seed.run,
      seed.userId,
      seed.remotes,
    ],
    { stdio: "inherit" },
  )
  if (advance.status !== 0)
    setupError("run-seed.ts advance failed; the stale-cursor case cannot run.")
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
