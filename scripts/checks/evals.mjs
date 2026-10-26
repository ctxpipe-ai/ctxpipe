import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { logFile, logged } from "./log.mjs"

// The eval checks: one for each MCPJam eval case (lane `mcp`). The memory live
// eval scenarios have no check until a live runner exists. They call paid
// models, so their results are stochastic, and they run only with the
// workbench environment. A reader selects them by intent, never by import or trace:
// their inputs are only their harness.

const root = fileURLToPath(new URL("../../", import.meta.url))
const cases = "apps/backend/evals/mcp/cases.ts"
const shared = ["package.json", "pnpm-lock.yaml", "scripts/checks/evals.mjs"]
const env = [
  { name: "MODEL_PROVIDER", mode: "value" },
  { name: "MCP_EVAL_MODELS", mode: "value" },
  { name: "MODEL_PROVIDER_API_KEY", mode: "presence" },
]
const baselineFile = join(root, "apps/backend/evals/mcp/baseline.json")

// The sorted, unique tool names that the rules of a case name.
// "*" stays as "*" (any tool).
function toolNames(item) {
  const rules = [...(item.calls ?? []), ...(item.forbidden ?? [])]
  return [
    ...new Set([
      ...rules.flatMap((rule) => [rule.tool ?? []].flat()),
      ...(item.parallel ?? []).flat(),
    ]),
  ].sort()
}

export async function listEvals() {
  // Node strips the types of cases.ts (it holds only data).
  const { evalCases } = await import("../../apps/backend/evals/mcp/cases.ts")
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
    tools: toolNames(item),
  }))
  return mcp
}

// The verdict of one case: the eval gate (gate.ts) with the same thresholds,
// cut to the case. The baseline keeps only the rate of this case.
export async function caseVerdict(run, caseId, stored, usage = {}) {
  const { evaluateGate } = await import("../../apps/backend/evals/mcp/gate.ts")
  const models = Object.keys(run.passes)
  const report = evaluateGate(
    {
      iterations: run.iterations,
      passes: Object.fromEntries(
        models.map((model) => [model, { [caseId]: run.passes[model]?.[caseId] }]),
      ),
    },
    stored && {
      ...stored,
      models: Object.fromEntries(
        Object.entries(stored.models).flatMap(([model, entry]) =>
          entry.cases[caseId] === undefined
            ? []
            : [
                [
                  model,
                  {
                    aggregate: entry.cases[caseId],
                    cases: { [caseId]: entry.cases[caseId] },
                  },
                ],
              ],
        ),
      ),
    },
    [caseId],
  )
  const own = (model) => (failure) => failure.startsWith(`${model}:`)
  return {
    cases: models.map((model) => {
      const passes = run.passes[model]?.[caseId] ?? 0
      const failures = report.failures.filter(own(model))
      // Without a baseline entry for this case, only the absolute floor of
      // the gate for one case applies.
      const baselined = stored?.models[model]?.cases[caseId] !== undefined
      return {
        name: model,
        status: failures.length ? "failed" : "passed",
        durationMs: usage?.[model]?.[caseId]?.durationMs ?? 0,
        message: [
          `${passes}/${run.iterations} iterations passed`,
          ...(baselined ? [] : ["no baseline"]),
          ...failures,
        ].join("; "),
      }
    }),
    general: report.failures.filter(
      (failure) => !models.some((model) => own(model)(failure)),
    ),
  }
}

// Runs MCP eval checks: one seed and one run of apps/backend/evals/mcp/run.ts
// for the selected cases (a seed supports one run). The prerequisites made
// sure that the workbench variables, the stores and the backend are there.
// The verdict of a case is the eval gate (gate.ts) for that one case.
export async function runEvals(checks) {
  const log = logFile("eval-mcp")
  const backend = join(root, "apps/backend")
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-eval-"))
  const records = []
  // Gate failures of the whole run. A record has its own verdict, so these
  // go to stderr as one note.
  const wholeRun = new Set()
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
              "3",
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
      const { cases, general } = await caseVerdict(
        result.result,
        caseId,
        JSON.parse(readFileSync(baselineFile, "utf8")),
        result.usage,
      )
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
      for (const failure of general) wholeRun.add(failure)
      records.push({
        id: check.id,
        status: !cases.length
          ? "error"
          : cases.some((item) => item.status === "failed")
            ? "failed"
            : "passed",
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
  if (wholeRun.size)
    process.stderr.write(`Eval gate, whole run: ${[...wholeRun].join("; ")}\n`)
  return { records }
}
