/**
 * The knowledge-plane evals (ADR-069 decisions 5 to 7). Run from
 * `apps/backend`, with the backend environment of the database that holds
 * the eval Workspaces (`DATABASE_URL`, `AUTH_SECRET`, `GRAPH_DB_URI`,
 * `CLICKHOUSE_URL`, and the model settings `MODEL_PROVIDER_*`):
 *
 *   bun evals/knowledge/cli.ts run --dataset FILE --targets FILE --out DIR \
 *     [--split dev|holdout] [--cap-usd 5] [--set NAME=VALUE] [--kept REPORT]
 *   bun evals/knowledge/cli.ts rescore --from DIR --out DIR \
 *     [--set NAME=VALUE] [--kept REPORT]
 *   bun evals/knowledge/cli.ts label --draft FILE --repo DIR \
 *     --models A,B,C --out FILE [--cap-usd 5]
 *   bun evals/knowledge/cli.ts corpus snapshot|issues|freeze --plan FILE \
 *     --out FILE
 *   bun evals/knowledge/cli.ts probe --out DIR [--cap-usd 0.25]
 *   bun evals/knowledge/cli.ts vision --out DIR [--models A,B,C] [--cap-usd 5]
 *
 * See README.md. Exit code 0: done. 2: bad setup. 3: the spend cap stopped
 * the command (the output holds the work before the stop). 4: a check of
 * `probe` failed.
 */
import { execFile } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs, promisify } from "node:util"

import { Octokit } from "octokit"

import { closeDb, initDb } from "../../src/db/client.js"
import { ORCHESTRATOR_DEFAULTS } from "../../src/knowledge-reader/orchestrator.js"
import { initEvlog } from "../../src/observability/logger.js"
import { closeGraphDb } from "../../src/platform/graph/client.js"
import { DEFAULT_OPENROUTER_BASE } from "../../src/retrieval/services/modelProvider.js"
import { buildConverter } from "../../test/converter.js"
import {
  freezeCorpora,
  importCorpusIssues,
  planSchema,
  snapshotRepositories,
} from "./corpus.js"
import { type Dataset, readDataset } from "./dataset.js"
import { ModelCalls, type RecordedCall } from "./model-calls.js"
import { labelWithPanel } from "./panel.js"
import { probe } from "./probe.js"
import {
  buildReport,
  type KeptRun,
  keptRunSchema,
  renderMarkdown,
  type Report,
} from "./report.js"
import {
  applySettings,
  type Manifest,
  parseSettings,
  readJson,
  readRun,
  runEval,
  type Settings,
  type Targets,
  targetsSchema,
  writeJson,
  writeRun,
} from "./runner.js"
import { runVision, VISION_MODELS } from "./vision.js"

/** The model calls go to `MODEL_PROVIDER_URL`, as in the readers. */
const modelBase = () =>
  process.env.MODEL_PROVIDER_URL || DEFAULT_OPENROUTER_BASE
const modelCalls = (capUsd: number, replay?: readonly RecordedCall[]) =>
  new ModelCalls(modelBase(), capUsd, replay)

/**
 * Run the questions of `splits` through both arms, then write the run folder
 * and its report (`report.json`, `report.md`) to `out`. With `replay`, each
 * model answer comes from those recorded calls and no call goes out.
 */
export async function executeRun(input: {
  dataset: Dataset
  targets: Targets
  splits: Manifest["splits"]
  settings: Settings
  capUsd: number
  now: Date
  out: string
  kept: KeptRun | null
  replay?: readonly RecordedCall[]
}): Promise<Report> {
  const calls = modelCalls(input.capUsd, input.replay)
  const restoreSettings = applySettings(input.settings)
  const restoreFetch = calls.install()
  try {
    const answers = await runEval({
      dataset: input.dataset,
      questions: input.dataset.questions.filter((question) =>
        input.splits.includes(question.split),
      ),
      targets: input.targets,
      calls,
      now: input.now,
    })
    const manifest: Manifest = {
      datasetVersion: input.dataset.version,
      splits: input.splits,
      now: input.now.toISOString(),
      settings: input.settings,
      loop: { ...ORCHESTRATOR_DEFAULTS },
      mode: input.replay ? "replay" : "live",
      capUsd: input.capUsd,
      spentUsd: calls.spentUsd,
      stopped: calls.stopped,
    }
    await writeRun(input.out, {
      manifest,
      dataset: input.dataset,
      targets: input.targets,
      answers,
      calls: calls.records,
    })
    const report = buildReport({
      manifest,
      dataset: input.dataset,
      answers,
      kept: input.kept,
    })
    await writeJson(join(input.out, "report.json"), report)
    await writeFile(join(input.out, "report.md"), renderMarkdown(report))
    return report
  } finally {
    restoreFetch()
    restoreSettings()
  }
}

class SetupError extends Error {}

/** Label a draft with the judge panel. Returns the exit code. */
async function label(values: {
  draft?: string
  repo?: string
  models?: string
  out: string
  capUsd: number
}): Promise<number> {
  if (!values.draft || !values.repo || !values.models)
    throw new SetupError("label needs --draft, --repo and --models.")
  const repo = values.repo
  const draft = await readDataset(values.draft)
  const shas = new Map(
    draft.corpora.map((corpus) => [corpus.id, corpus.contextRepo.sha]),
  )
  const calls = modelCalls(values.capUsd)
  const restore = calls.install()
  try {
    const labeled = await labelWithPanel({
      draft,
      models: values.models.split(",").filter(Boolean),
      read: async (corpus, ref) =>
        (
          await promisify(execFile)("git", [
            "-C",
            repo,
            "show",
            `${shas.get(corpus)}:${ref}`,
          ])
        ).stdout,
      env: process.env,
      stopped: () => calls.stopped,
    })
    await writeJson(values.out, labeled.dataset)
    await writeJson(`${values.out}.votes.json`, {
      votes: labeled.votes,
      dropped: labeled.dropped,
      stopped: labeled.stopped,
      spentUsd: calls.spentUsd,
    })
    return labeled.stopped ? 3 : 0
  } finally {
    restore()
  }
}

/**
 * One step of the public corpora (`corpus.ts`). `GITHUB_TOKEN` must be able
 * to make and push to the private repositories of the plan's owner.
 */
async function corpus(
  step: string | undefined,
  plan: string | undefined,
  out: string,
) {
  if (!plan) throw new SetupError("corpus needs --plan.")
  const parsed = planSchema.parse(await readJson(plan))
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new SetupError("corpus needs GITHUB_TOKEN.")
  // Wait for a rate limit to reset, then go on.
  const wait = () => true
  const access = {
    octokit: new Octokit({
      auth: token,
      throttle: { onRateLimit: wait, onSecondaryRateLimit: wait },
    }),
    token,
    gitBase: "https://github.com",
  }
  const log = (line: string) => process.stderr.write(`${line}\n`)
  if (step === "snapshot")
    await writeJson(out, await snapshotRepositories(parsed, access, log))
  else if (step === "issues")
    await writeJson(out, await importCorpusIssues(parsed, access, log))
  else if (step === "freeze") await freezeCorpora(parsed, access, out)
  else throw new SetupError("Use corpus snapshot, issues or freeze.")
  return 0
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      plan: { type: "string" },
      dataset: { type: "string" },
      targets: { type: "string" },
      out: { type: "string" },
      from: { type: "string" },
      split: { type: "string" },
      // The spend cap of the command, in USD. The default is $5, and $0.25
      // for `probe`.
      "cap-usd": { type: "string" },
      set: { type: "string", multiple: true },
      kept: { type: "string" },
      draft: { type: "string" },
      repo: { type: "string" },
      models: { type: "string" },
    },
  })
  const capUsd = Number(values["cap-usd"] ?? (command === "probe" ? 0.25 : 5))
  if (!Number.isFinite(capUsd) || capUsd < 0)
    throw new SetupError("--cap-usd needs a number of 0 or more.")
  if (!values.out) throw new SetupError("Give --out.")
  const out = values.out
  if (command === "label") return label({ ...values, out, capUsd })
  if (command === "corpus") return corpus(positionals[0], values.plan, out)
  if (command === "probe") {
    if (!process.env.MODEL_PROVIDER_API_KEY)
      throw new SetupError("probe needs MODEL_PROVIDER_API_KEY.")
    const calls = modelCalls(capUsd)
    return probe({ out, calls, capUsd, base: modelBase() })
  }

  if (command === "vision") {
    if (!process.env.MODEL_PROVIDER_API_KEY)
      throw new SetupError("vision needs MODEL_PROVIDER_API_KEY.")
    // The SVG fixtures go through the converter, and the export of
    // `factory eval` has no build of it.
    buildConverter()
    const calls = modelCalls(capUsd)
    const restore = calls.install()
    try {
      const result = await runVision({
        models: values.models?.split(",").filter(Boolean) ?? VISION_MODELS,
        out,
        calls,
        capUsd,
        base: modelBase(),
      })
      process.stdout.write(`The report is in ${join(out, "vision.md")}.\n`)
      return result.stopped ? 3 : 0
    } finally {
      restore()
    }
  }

  if (command !== "run" && command !== "rescore")
    throw new SetupError(
      "Use the command run, rescore, label, corpus, probe or vision.",
    )
  if (!process.env.DATABASE_URL) throw new SetupError("Set DATABASE_URL.")
  const kept = values.kept
    ? keptRunSchema.parse(await readJson(values.kept))
    : null
  const settings = parseSettings(values.set ?? [])
  initDb(process.env.DATABASE_URL)
  try {
    let report: Report
    if (command === "rescore") {
      if (!values.from) throw new SetupError("rescore needs --from.")
      const recorded = await readRun(values.from)
      report = await executeRun({
        dataset: recorded.dataset,
        targets: recorded.targets,
        splits: recorded.manifest.splits,
        settings: { ...recorded.manifest.settings, ...settings },
        capUsd: 0,
        now: new Date(recorded.manifest.now),
        out,
        kept,
        replay: recorded.calls,
      })
    } else {
      if (!values.dataset || !values.targets)
        throw new SetupError("run needs --dataset and --targets.")
      const splits: Manifest["splits"] =
        values.split === "dev" || values.split === "holdout"
          ? [values.split]
          : ["dev", "holdout"]
      if (values.split && splits.length !== 1)
        throw new SetupError("--split is dev or holdout.")
      report = await executeRun({
        dataset: await readDataset(values.dataset),
        targets: targetsSchema.parse(await readJson(values.targets)),
        splits,
        settings,
        capUsd,
        now: new Date(),
        out,
        kept,
      })
    }
    process.stdout.write(`The report is in ${join(out, "report.md")}.\n`)
    return report.run.stopped ? 3 : 0
  } finally {
    await closeGraphDb()
    await closeDb()
  }
}

if (import.meta.main) {
  initEvlog()
  const code = await main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)} See apps/backend/evals/knowledge/README.md.\n`,
    )
    return error instanceof SetupError ? 2 : 1
  })
  // The ClickHouse client of the plane reader keeps the process open.
  process.exit(code)
}
