import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { parse } from "yaml"

import { logFile, logged } from "./log.mjs"

// The eval checks: one for each MCPJam eval case (lane `mcp`) and one for
// each memory live eval scenario (lane `cli-memory`). They call paid models,
// so their results are stochastic, and they run only with the workbench
// environment. A reader selects them by intent, never by import or trace:
// their inputs are only their harness.

const root = fileURLToPath(new URL("../../", import.meta.url))
const cases = "apps/backend/evals/mcp/cases.ts"
const scenarios = "packages/cli/test/memory/evals/scenarios"
const shared = ["package.json", "pnpm-lock.yaml", "scripts/checks/evals.mjs"]
const env = [
  { name: "MODEL_PROVIDER", mode: "value" },
  { name: "MCP_EVAL_MODELS", mode: "value" },
  { name: "MODEL_PROVIDER_API_KEY", mode: "presence" },
]
// A model passes a case when it passes this share of its iterations: the
// floor of the eval gate (apps/backend/evals/mcp/gate.ts, minPassRate).
const minPassRate = 0.9
const iterations = 3

export async function listEvals() {
  // Node strips the types of cases.ts (it holds only data).
  const { evalCases } = await import(pathToFileURL(join(root, cases)).href)
  const mcp = evalCases.map((item) => ({
    id: `eval:mcp:${cases}#${item.id}`,
    family: "eval",
    lane: "mcp",
    root: "apps/backend/evals/mcp",
    file: cases,
    inputs: [
      ...shared,
      "apps/backend/package.json",
      "apps/backend/evals/mcp/**",
    ],
    runtime: "bun",
    env,
    prerequisites: [
      "workbench",
      "postgres",
      "migrations",
      "falkordb",
      "bun",
      "codesearch-server",
      "mcp-server",
    ],
    stochastic: true,
    intent: item.intent,
  }))
  const memory = readdirSync(join(root, scenarios))
    .filter((name) => name.endsWith(".yaml"))
    .sort()
    .map((name) => {
      const file = `${scenarios}/${name}`
      return {
        id: `eval:cli-memory:${file}`,
        family: "eval",
        lane: "cli-memory",
        root: "packages/cli/test/memory/evals",
        file,
        inputs: [
          ...shared,
          "packages/cli/package.json",
          "packages/cli/src/**",
          "packages/cli/test/memory/evals/**",
        ],
        env,
        prerequisites: ["workbench", "memory-live-runner"],
        stochastic: true,
        intent: parse(readFileSync(join(root, file), "utf8")).intent,
      }
    })
  return [...mcp, ...memory]
}

// Runs MCP eval checks: one seed and one run of apps/backend/evals/mcp/run.ts
// for the selected cases (a seed supports one run). The prerequisites made
// sure that the workbench variables, the stores and the backend are there.
// The memory evals never get here: their prerequisite has no runner yet.
export function runEvals(checks) {
  const log = logFile("eval-mcp")
  const backend = join(root, "apps/backend")
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-eval-"))
  const records = []
  try {
    const seed = join(directory, "seed.json")
    const out = join(directory, "results.json")
    const run = `checks${Date.now()}`
    const started = performance.now()
    const seeded = logged(
      log.path,
      "bun",
      ["evals/mcp/run-seed.ts", "ci", run, join(directory, "fixtures"), seed],
      { cwd: backend, timeout: 1_800_000 },
    )
    const ids = checks.map((check) => check.id.split("#")[1])
    const ran =
      seeded.status === 0
        ? logged(
            log.path,
            "bun",
            [
              "evals/mcp/run.ts",
              "--url",
              new URL("/mcp", process.env.AUTH_BASE_URL).href,
              "--seed",
              seed,
              "--models",
              process.env.MCP_EVAL_MODELS,
              "--iterations",
              String(iterations),
              "--cases",
              ids.join(","),
              "--out",
              out,
            ],
            { cwd: backend, timeout: 5_400_000 },
          )
        : undefined
    let result
    try {
      result = JSON.parse(readFileSync(out, "utf8"))
    } catch {
      const message =
        seeded.status !== 0
          ? "The eval seed failed; see the log"
          : `The eval run wrote no results (exit ${ran?.status ?? ran?.signal}); see the log`
      const durationMs = Math.round(performance.now() - started)
      return {
        records: checks.map(({ id }) => ({
          id,
          status: "error",
          durationMs,
          cases: [],
          log: log.relative,
          message,
        })),
      }
    }
    for (const [index, check] of checks.entries()) {
      const caseId = ids[index]
      const models = Object.keys(result.result.passes)
      const cases = models.map((model) => {
        const passes = result.result.passes[model]?.[caseId] ?? 0
        return {
          name: model,
          status:
            passes / result.result.iterations >= minPassRate
              ? "passed"
              : "failed",
          durationMs: result.usage?.[model]?.[caseId]?.durationMs ?? 0,
          message: `${passes}/${result.result.iterations} iterations passed`,
        }
      })
      const usage = models.flatMap((model) => {
        const used = result.usage?.[model]?.[caseId]
        if (!used) return []
        return [
          {
            model,
            inputTokens: used.inputTokens,
            outputTokens: used.outputTokens,
            ...(used.costUsd !== undefined && { costUsd: used.costUsd }),
          },
        ]
      })
      records.push({
        id: check.id,
        status: !cases.length
          ? "error"
          : cases.every((item) => item.status === "passed")
            ? "passed"
            : "failed",
        durationMs: cases.reduce((sum, item) => sum + item.durationMs, 0),
        cases,
        log: log.relative,
        usage,
        ...(!cases.length && { message: "The eval run has no result" }),
      })
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  return { records }
}
