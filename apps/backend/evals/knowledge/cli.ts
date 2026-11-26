/**
 * The knowledge-plane evals (ADR-069 decisions 5 to 7). Run from
 * `apps/backend`, with the backend environment of the database that holds
 * the eval Workspaces (`DATABASE_URL`, `AUTH_SECRET`, `CLICKHOUSE_URL`,
 * and the model settings `MODEL_PROVIDER_*`):
 *
 *   bun evals/knowledge/cli.ts hydrate --dataset FILE --out DIR [--cap-usd 5]
 *   bun evals/knowledge/cli.ts run --dataset FILE --targets FILE --out DIR \
 *     [--split dev|holdout] [--cap-usd 5] [--set NAME=VALUE] [--kept REPORT]
 *     --baseline-from RUN_DIR [--reuse-from RUN_DIR]
 *   bun evals/knowledge/cli.ts rescore --from DIR --out DIR \
 *     [--set NAME=VALUE] [--kept REPORT] [--unrecorded-yes P]
 *   bun evals/knowledge/cli.ts draft --dataset FILE --corpus ID --repo DIR \
 *     --model MODEL --out FILE [--seed TEXT] [--scale 0.4] [--resume DRAFT]
 *     [--cap-usd 10]
 *   bun evals/knowledge/cli.ts finalize --draft LABELED,... --out FILE
 *   bun evals/knowledge/cli.ts label --draft FILE --repo DIR \
 *     --models A,B,C --out FILE [--cap-usd 5]
 *   bun evals/knowledge/cli.ts corpus sources|issues|chat|freeze --plan FILE \
 *     --out FILE|DIR
 *   bun evals/knowledge/cli.ts probe --out DIR [--setting NAME=VALUE ...]
 *     [--cap-usd 1]
 *   bun evals/knowledge/cli.ts latency --out DIR [--runs 50] [--cap-usd 2]
 *   bun evals/knowledge/cli.ts vision --out DIR [--models A,B,C] [--cap-usd 5]
 *
 * See README.md. Exit code 0: done. 1: an error, or (`run`, `rescore`) an
 * answer with a failed call. 2: bad setup. 3: the spend cap stopped the
 * command (the output holds the work before the stop). 4: a check of
 * `probe` failed.
 */
// First: it sets the OpenWorkflow namespace before the client loads.
import "./eval-namespace.js"
import { execFile, execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs, promisify } from "node:util"

import { Octokit } from "octokit"
import { z } from "zod"

import { closeDb, initDb } from "../../src/db/client.js"
import { ORCHESTRATOR_DEFAULTS } from "../../src/knowledge-reader/orchestrator.js"
import { initEvlog } from "../../src/observability/logger.js"
import {
  allowlistSettingsProblem,
  DEFAULT_OPENROUTER_BASE,
  providerAllowlist,
} from "../../src/retrieval/services/openRouterProvider.js"
import { modelProviderProblem } from "./chat.js"
import {
  exportCorpusChat,
  freezeCorpora,
  importCorpusMirrors,
  planSchema,
  writeCorpusSources,
} from "./corpus.js"
import {
  type Dataset,
  datasetSchema,
  frozenCorporaSchema,
  onePositionEach,
  questionProblems,
  questionSchema,
  readDataset,
} from "./dataset.js"
import { loadDocuments, termIndex } from "./documents.js"
import {
  attemptsFileSchema,
  draftQuestions,
  finalizeQuestions,
  ResumeMismatchError,
} from "./draft.js"
import type { EvalOrg } from "./hydrate.js"
import { measureLatency } from "./latency.js"
import { ModelCalls, type RecordedCall } from "./model-calls.js"
import { labelWithPanel } from "./panel.js"
import { applyProbeSettings, probe } from "./probe.js"
import {
  buildReport,
  type KeptRun,
  keptRunSchema,
  renderMarkdown,
  type Report,
} from "./report.js"
import {
  type ArmAnswer,
  applySettings,
  type Manifest,
  parseSettings,
  readJson,
  readRun,
  runEval,
  SetupError,
  type Settings,
  type RunFolder,
  type Targets,
  targetsSchema,
  writeJson,
  writeRun,
} from "./runner.js"
import { runVision, VISION_MODELS } from "./vision.js"

/** The model calls go to `MODEL_PROVIDER_URL`, as in the readers. */
const modelBase = () =>
  process.env.MODEL_PROVIDER_URL || DEFAULT_OPENROUTER_BASE
const modelCalls = (
  capUsd: number,
  replay?: readonly RecordedCall[],
  options?: ConstructorParameters<typeof ModelCalls>[3],
) => new ModelCalls(modelBase(), capUsd, replay, options)

/**
 * Run the questions of `splits` through both arms, then write the run folder
 * and its report (`report.json`, `report.md`) to `out`. With `replay`, each
 * model answer comes from the recorded calls of an earlier run and no call
 * goes out. The report keeps the calls that got the ZDR block in that run.
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
  replay?: { calls: readonly RecordedCall[]; unrecordedYes?: number }
  /** The quiet time before the first calls of each arm (check 7). */
  quietMs: number
  /**
   * An earlier run folder (`--baseline-from`, or the `--from` folder of a
   * rescore): the run reuses its answers of the old stack, and runs only the
   * plane. The old stack is gone (CTX-1713).
   */
  baseline: RunFolder
  /**
   * An earlier run folder (`--reuse-from`): each model request of the run
   * that is the same as a recorded request of that folder (the same arm,
   * question, kind and body, with no `provider` block) gets the recorded
   * answer. Only the other requests go out. Thus the scores of the run move
   * only where its code changed a request.
   */
  reuse?: RunFolder
}): Promise<Report> {
  const questions = input.dataset.questions.filter((question) =>
    input.splits.includes(question.split),
  )
  if (input.reuse)
    checkSameDataset("--reuse-from", input.dataset, input.reuse, questions)
  const baseline = storedBaseline(input.dataset, input.baseline, questions)
  // Both arms answer at the same query time. A reused request holds the
  // query time, so the run takes the one of the reused folder.
  const times = [input.baseline, ...(input.reuse ? [input.reuse] : [])].map(
    (folder) => folder.run.manifest.now,
  )
  if (new Set(times).size > 1)
    throw new SetupError(
      "--baseline-from and --reuse-from have other query times.",
    )
  const now = times[0] ? new Date(times[0]) : input.now
  // A replay sends no call. Each client of a live run sends the provider
  // block (ADR-070). A run with `--reuse-from` sends only the calls that
  // the recording does not hold.
  const unrecordedYes = input.replay?.unrecordedYes
  const calls = modelCalls(
    input.capUsd,
    input.replay?.calls ?? input.reuse?.run.calls,
    input.reuse
      ? { liveFallback: true }
      : unrecordedYes === undefined
        ? undefined
        : { unrecordedYes },
  )
  // The folder keeps the calls of the reused answers, so that a replay of
  // this run has each call of both arms.
  calls.records.push(
    ...input.baseline.run.calls.filter(
      (call) => call.arm === "legacy" && baseline.has(call.question),
    ),
  )
  // An eval has no time budget, so that a slow step does not hide what the
  // loop finds (the CTO, 2026-11-22). `--set timeBudgetMs=…` sets one.
  const productBudgetMs = ORCHESTRATOR_DEFAULTS.timeBudgetMs
  const restoreSettings = applySettings({ timeBudgetMs: 0, ...input.settings })
  const restoreFetch = calls.install()
  try {
    const { answers, projectionVersions } = await runEval({
      dataset: input.dataset,
      questions,
      targets: input.targets,
      calls,
      now,
      quietMs: input.quietMs,
      baseline,
    })
    const manifest: Manifest = {
      datasetVersion: input.dataset.version,
      splits: input.splits,
      now: now.toISOString(),
      settings: input.settings,
      loop: { ...ORCHESTRATOR_DEFAULTS },
      productBudgetMs,
      quietMs: input.quietMs,
      mode: input.replay ? "replay" : input.reuse ? "reuse" : "live",
      baselineFrom: input.baseline.folder,
      ...(input.reuse
        ? { reuse: { from: input.reuse.folder, ...calls.reuseSummary() } }
        : {}),
      ...(unrecordedYes === undefined ? {} : { unrecordedYes }),
      projectionVersions,
      ...calls.summary(),
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

/**
 * Refuses an earlier run folder (of the option `flag`) that the run cannot
 * compare with, because it has one of these differences:
 * - another dataset version;
 * - another snapshot of a corpus;
 * - other labels of a question of the run: its gold, positions, seeds,
 *   split or text, so a new `label` run is a refusal too.
 */
function checkSameDataset(
  flag: string,
  dataset: Dataset,
  { folder, run }: RunFolder,
  questions: readonly Dataset["questions"][number][],
): void {
  if (run.manifest.datasetVersion !== dataset.version)
    throw new SetupError(
      `${flag} ${folder} has dataset version ${run.manifest.datasetVersion}, and the run has version ${dataset.version}.`,
    )
  // The context repo URL can differ (a local copy of the same SHA).
  const snapshot = (corpus: Dataset["corpora"][number]) =>
    JSON.stringify([
      corpus.id,
      corpus.source,
      corpus.contextRepo.sha,
      corpus.contextRepo.root,
      corpus.workspace,
    ])
  const storedCorpora = new Set(run.dataset.corpora.map(snapshot))
  const corpus = dataset.corpora.find(
    (item) => !storedCorpora.has(snapshot(item)),
  )
  if (corpus)
    throw new SetupError(
      `${flag} ${folder} has another snapshot of the corpus ${corpus.id}.`,
    )
  const storedQuestions = new Map(
    run.dataset.questions.map((question) => [
      question.id,
      JSON.stringify(question),
    ]),
  )
  for (const question of questions)
    if (storedQuestions.get(question.id) !== JSON.stringify(question))
      throw new SetupError(
        `${flag} ${folder} has other labels for the question ${question.id}.`,
      )
}

/**
 * The stored answers of the old stack in `baseline`, by question id, for
 * the `questions` of the run. Refuses a folder that `checkSameDataset`
 * refuses, and a folder with no complete old-stack answer to a question of
 * the run: no answer, a missed call of a replay, or a failed call.
 */
function storedBaseline(
  dataset: Dataset,
  baseline: RunFolder,
  questions: readonly Dataset["questions"][number][],
): Map<string, ArmAnswer> {
  checkSameDataset("--baseline-from", dataset, baseline, questions)
  const { folder, run } = baseline
  const answers = new Map(
    run.answers
      .filter((answer) => answer.arm === "legacy")
      .map((answer) => [answer.question, answer]),
  )
  const kept = new Map<string, ArmAnswer>()
  for (const question of questions) {
    // A replay that missed a call scores no answer, and the metrics of a
    // run with a failed call are not for use: neither is a baseline.
    const answer = answers.get(question.id)
    const failed =
      !answer ||
      answer.calls.missing > 0 ||
      answer.calls.failed > 0 ||
      "error" in answer.search ||
      (answer.related !== undefined && "error" in answer.related)
    if (failed)
      throw new SetupError(
        `--baseline-from ${folder} has no complete answer of the old stack to the question ${question.id}.`,
      )
    kept.set(question.id, answer)
  }
  return kept
}

/**
 * The quiet time before the first calls of each arm (check 7): longer than
 * the idle timeout of the Postgres pool (30 s, `src/db/client.ts`).
 */
const QUIET_MS = 31_000

/** Build the file converter: the export of `factory eval` has no build of it. */
function buildConverter() {
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          "../../../../scripts/checks/prerequisites.mjs",
          import.meta.url,
        ),
      ),
      "converter",
    ],
    // Its result line (and the fix of a failure) goes to stderr.
    { stdio: ["ignore", 2, "inherit"] },
  )
}

/**
 * Hydrate each corpus into the plane in `org` (`hydrate.ts`), and write the
 * targets of `run` (`targets.json`) to `out`. It writes the spend and the
 * failed documents of the plane (`hydrate.json`) also when the hydrate
 * fails. Returns the exit code: 3 when the spend cap stopped a call. Then it
 * writes no targets, also when the workflows completed. Throws the other
 * errors.
 */
export async function hydrateCommand(input: {
  dataset: Dataset
  org: EvalOrg
  databaseUrl: string
  out: string
  capUsd: number
}): Promise<number> {
  // The hydrate sends each chunk of each corpus, so the recorder keeps no
  // call: a rescore replays only the calls of `run`.
  const calls = modelCalls(input.capUsd, undefined, { keepRecords: false })
  // Only `hydrate` loads the workflows: their OpenWorkflow client connects to
  // Postgres when it loads, and the other commands need no database.
  const { hydrateCorpora } = await import("./hydrate.js")
  const restore = calls.install()
  await mkdir(input.out, { recursive: true })
  let failedDocuments: Record<string, number> | null = null
  try {
    const hydrated = await hydrateCorpora({
      dataset: input.dataset,
      org: input.org,
      databaseUrl: input.databaseUrl,
      calls,
      log: (line) => process.stderr.write(`${line}\n`),
    })
    failedDocuments = hydrated.failedDocuments
    if (calls.stopped) {
      process.stderr.write(
        "The spend cap stopped a call of the hydrate. Give a higher cap and run hydrate again.\n",
      )
      return 3
    }
    await writeJson(join(input.out, "targets.json"), hydrated.targets)
    process.stdout.write(
      `The targets are in ${join(input.out, "targets.json")}. Spend: $${calls.spentUsd.toFixed(4)}.\n`,
    )
    return 0
  } catch (error) {
    // A call that the cap stopped fails its workflow step.
    if (calls.stopped) {
      process.stderr.write(
        `The spend cap stopped the hydrate: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      return 3
    }
    throw error
  } finally {
    restore()
    await writeJson(join(input.out, "hydrate.json"), {
      ...calls.summary(),
      failedDocuments,
    })
  }
}

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
  // The gold paths are relative to the root of the corpus.
  const trees = new Map(
    draft.corpora.map(({ id, contextRepo: { sha, root } }) => [
      id,
      root ? `${sha}:${root}/` : `${sha}:`,
    ]),
  )
  // The nearest documents of a no-answer question, from the term index of
  // its corpus. The panel judges them.
  const indexes = new Map<string, ReturnType<typeof termIndex>>()
  const nearest = async (id: string, text: string) => {
    const corpus = draft.corpora.find((item) => item.id === id)
    if (!corpus) return []
    const index =
      indexes.get(id) ??
      termIndex(
        loadDocuments(repo, corpus.contextRepo.sha, corpus.contextRepo.root),
      )
    indexes.set(id, index)
    return index.nearest(text, 3)
  }
  // The panel scrubs each document with the converter.
  buildConverter()
  const calls = modelCalls(values.capUsd)
  const restore = calls.install()
  try {
    const labeled = await labelWithPanel({
      draft,
      models: values.models.split(",").filter(Boolean),
      read: async (corpus, ref) =>
        (
          await promisify(execFile)(
            "git",
            ["-C", repo, "show", `${trees.get(corpus)}${ref}`],
            { maxBuffer: 1 << 28 },
          )
        ).stdout,
      nearest,
      env: process.env,
      stopped: () => calls.stopped,
    })
    await writeJson(values.out, labeled.dataset)
    await writeJson(`${values.out}.votes.json`, {
      votes: labeled.votes,
      timeVotes: labeled.timeVotes,
      dropped: labeled.dropped,
      stopped: labeled.stopped,
      budget: labeled.budget,
      spentUsd: calls.spentUsd,
    })
    return labeled.stopped ? 3 : 0
  } finally {
    restore()
  }
}

/**
 * The draft `file` (and `file.attempts.json`) of the corpus `corpusId`, for a
 * resume with `seed` and `scale`.
 */
async function readResume(
  file: string,
  corpusId: string,
  seed: string,
  scale: number,
) {
  const earlier = z
    .object({
      corpora: z.array(z.object({ id: z.string() })),
      questions: z.array(questionSchema),
    })
    .parse(JSON.parse(await readFile(file, "utf8")))
  const audit = attemptsFileSchema.parse(
    JSON.parse(await readFile(`${file}.attempts.json`, "utf8")),
  )
  if (earlier.corpora.some((item) => item.id !== corpusId))
    throw new SetupError(`--resume ${file} is not a draft of ${corpusId}.`)
  if (
    (audit.seed !== undefined && audit.seed !== seed) ||
    (audit.scale !== undefined && audit.scale !== scale)
  )
    throw new SetupError(
      `--resume ${file} has another seed or scale: use the same ones.`,
    )
  return {
    questions: earlier.questions,
    // An older attempts file also keeps the pick of the failed call as an
    // attempt, with the failure as its reason. Remove that attempt, so that
    // the resume drafts the pick again. A refused pick stays.
    attempts: audit.attempts.filter(
      (attempt) =>
        !audit.failed || attempt.refused || attempt.reason !== audit.failed,
    ),
    spentUsd: audit.spentUsd ?? 0,
  }
}

/**
 * Draft the questions of the corpus `corpus` of the frozen dataset
 * `dataset` (`draft.ts`). The output holds that corpus and its drafted
 * questions, and `label` labels it. Each attempt goes to
 * `OUT.attempts.json`. The output is written also when the spend cap stops
 * the command or a call fails, with the drafts before it.
 */
async function draft(values: {
  dataset?: string
  corpus?: string
  repo?: string
  model?: string
  seed?: string
  scale?: string
  resume?: string
  out: string
  capUsd: number
}): Promise<number> {
  const { dataset, repo, model } = values
  const problem = modelProviderProblem(process.env)
  if (problem) throw new SetupError(problem)
  const scale = Number(values.scale ?? 1)
  if (!(scale > 0 && scale <= 1))
    throw new SetupError("--scale needs a number above 0 and at most 1.")
  if (!dataset || !values.corpus || !repo || !model)
    throw new SetupError("draft needs --dataset, --corpus, --repo and --model.")
  const frozen = frozenCorporaSchema.parse(
    JSON.parse(await readFile(dataset, "utf8")),
  )
  // One corpus for each command, so that a failure costs one corpus only.
  const corpus = frozen.corpora.find((item) => item.id === values.corpus)
  if (!corpus)
    throw new SetupError(
      `--corpus names one corpus of the dataset: ${frozen.corpora.map((item) => item.id).join(", ")}.`,
    )
  const seed = `${values.seed ?? "v0"} ${corpus.id}`
  const resume = values.resume
    ? await readResume(values.resume, corpus.id, seed, scale)
    : undefined
  // The drafter scrubs each document with the converter.
  buildConverter()
  const calls = modelCalls(values.capUsd)
  const restore = calls.install()
  try {
    const drafted = await draftQuestions({
      ...(resume ? { resume } : {}),
      corpus,
      documents: loadDocuments(
        repo,
        corpus.contextRepo.sha,
        corpus.contextRepo.root,
      ),
      model,
      seed,
      scale,
      env: process.env,
      stopped: () => calls.stopped,
    }).catch((error: unknown) => {
      if (error instanceof ResumeMismatchError)
        throw new SetupError(error.message)
      throw error
    })
    // Also after a stop or a failed call: the drafts before it stay.
    await writeJson(values.out, {
      version: frozen.version,
      corpora: [corpus],
      questions: drafted.questions,
    })
    await writeJson(`${values.out}.attempts.json`, {
      attempts: drafted.attempts,
      seed,
      scale,
      stopped: drafted.stopped,
      failed: drafted.failed,
      failedRefusal: drafted.failedRefusal,
      budget: drafted.budget,
      // The picks that OpenRouter refused (HTTP 403).
      refused: drafted.attempts.filter((attempt) => attempt.refused).length,
      // The spend of the corpus: of this command and of the draft it resumed.
      spentUsd: calls.spentUsd + (resume?.spentUsd ?? 0),
    })
    process.stderr.write(
      `${corpus.id}: ${drafted.questions.length} questions, $${calls.spentUsd.toFixed(2)} spent by this command.\n`,
    )
    if (drafted.failed) throw new Error(drafted.failed)
    return drafted.stopped ? 3 : 0
  } finally {
    restore()
  }
}

/**
 * One step of the public corpora (`corpus.ts`). `GITHUB_TOKEN` must be able
 * to make and push to the private repositories of the plan's owner. The
 * `chat` step reads only public chat, so it needs no token.
 */
async function corpus(
  step: string | undefined,
  plan: string | undefined,
  out: string,
) {
  if (!plan) throw new SetupError("corpus needs --plan.")
  const parsed = planSchema.parse(await readJson(plan))
  const log = (line: string) => process.stderr.write(`${line}\n`)
  if (step === "chat") {
    await exportCorpusChat(parsed, out, log)
    return 0
  }
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
  if (step === "sources")
    await writeJson(out, await writeCorpusSources(parsed, access, log))
  else if (step === "issues")
    await writeJson(out, await importCorpusMirrors(parsed, access, log))
  else if (step === "freeze") await freezeCorpora(parsed, access, out)
  else throw new SetupError("Use corpus sources, issues, chat or freeze.")
  return 0
}

export async function main(argv: string[]): Promise<number> {
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
      // The spend cap of the command, in USD. The default is $5, $1 for
      // `probe` and $2 for `latency`.
      "cap-usd": { type: "string" },
      set: { type: "string", multiple: true },
      kept: { type: "string" },
      "baseline-from": { type: "string" },
      "reuse-from": { type: "string" },
      "unrecorded-yes": { type: "string" },
      draft: { type: "string" },
      repo: { type: "string" },
      models: { type: "string" },
      corpus: { type: "string" },
      model: { type: "string" },
      seed: { type: "string" },
      scale: { type: "string" },
      resume: { type: "string" },
      runs: { type: "string" },
      setting: { type: "string", multiple: true },
    },
  })
  const capUsd = Number(
    values["cap-usd"] ??
      (command === "probe" ? 1 : command === "latency" ? 2 : 5),
  )
  if (!Number.isFinite(capUsd) || capUsd < 0)
    throw new SetupError("--cap-usd needs a number of 0 or more.")
  if (!values.out) throw new SetupError("Give --out.")
  const out = values.out
  // Each eval model call goes only to the providers of the allowlist (ADR-070):
  // `factory eval` gives the list of production. A command that sends a
  // model call stops without it, so that no run can forget it.
  // `probe` checks the list itself, with its own setting (`provider-allowlist`).
  if (
    ["draft", "label", "hydrate", "run", "latency", "vision"].includes(
      command ?? "",
    )
  ) {
    let problem: string | undefined
    try {
      problem = providerAllowlist()
        ? allowlistSettingsProblem({
            MODEL_PROVIDER: process.env.MODEL_PROVIDER,
            MODEL_PROVIDER_URL: process.env.MODEL_PROVIDER_URL,
            MODEL_PROVIDER_ALLOWLIST: process.env.MODEL_PROVIDER_ALLOWLIST,
          })
        : "Set MODEL_PROVIDER_ALLOWLIST: each eval model call goes only to the providers of the allowlist (factory eval gives the list of production)."
    } catch (error) {
      problem = (error as Error).message
    }
    if (problem) throw new SetupError(problem)
  }
  if (command === "label") return label({ ...values, out, capUsd })
  if (command === "draft") return draft({ ...values, out, capUsd })
  if (command === "finalize") {
    if (!values.draft)
      throw new SetupError("finalize needs --draft (the labeled files).")
    // No dataset check yet: a labeled file from before a stricter rule can
    // hold a question that the rule now rejects. `finalize` drops it.
    const labeled = await Promise.all(
      values.draft
        .split(",")
        .filter(Boolean)
        .map(async (file) =>
          frozenCorporaSchema
            .extend({ questions: z.array(questionSchema) })
            .parse(JSON.parse(await readFile(file, "utf8"))),
        ),
    )
    if (new Set(labeled.map((item) => item.version)).size > 1)
      throw new SetupError("The labeled files have different versions.")
    const corpora = new Map<string, Dataset["corpora"][number]>()
    for (const corpus of labeled.flatMap((item) => item.corpora)) {
      const known = corpora.get(corpus.id)
      if (known && JSON.stringify(known) !== JSON.stringify(corpus))
        throw new SetupError(`The labeled files give two corpora ${corpus.id}.`)
      corpora.set(corpus.id, corpus)
    }
    // Two labeled questions with one id, or a question of no corpus of the
    // files, are faults of the input, not of a label: they stop here.
    const ids = new Set<string>()
    for (const question of labeled.flatMap((item) => item.questions)) {
      if (ids.has(question.id))
        throw new SetupError(`The labeled files hold ${question.id} twice.`)
      ids.add(question.id)
      if (!corpora.has(question.corpus))
        throw new SetupError(
          `${question.id} names the corpus ${question.corpus}, which no labeled file holds.`,
        )
    }
    // Each document is in one position, then the rules of `dataset.ts` drop
    // a question and list it.
    const checked = labeled
      .flatMap((item) => item.questions)
      .map((question) => {
        const next = question.positions
          ? { ...question, positions: onePositionEach(question.positions) }
          : question
        return { question: next, problems: questionProblems(next) }
      })
    const dropped = checked
      .filter(({ problems }) => problems.length > 0)
      .map(({ question, problems }) => ({
        question: question.id,
        reason: problems.join("; "),
      }))
    for (const { question, reason } of dropped)
      process.stderr.write(`Dropped ${question}: ${reason}.\n`)
    await writeJson(`${out}.dropped.json`, { dropped })
    await writeJson(
      out,
      datasetSchema.parse({
        version: labeled[0]?.version,
        corpora: [...corpora.values()],
        questions: finalizeQuestions(
          checked
            .filter(({ problems }) => problems.length === 0)
            .map(({ question }) => question),
        ),
      }),
    )
    return 0
  }
  if (command === "corpus") return corpus(positionals[0], values.plan, out)
  if (command === "probe") {
    if (!process.env.MODEL_PROVIDER_API_KEY)
      throw new SetupError("probe needs MODEL_PROVIDER_API_KEY.")
    try {
      applyProbeSettings(values.setting ?? [])
    } catch (error) {
      throw new SetupError((error as Error).message)
    }
    // Each model call scrubs its text with it (ADR-072).
    buildConverter()
    const calls = modelCalls(capUsd)
    return probe({ out, calls, capUsd, base: modelBase() })
  }

  if (command === "latency") {
    if (!process.env.MODEL_PROVIDER_API_KEY)
      throw new SetupError("latency needs MODEL_PROVIDER_API_KEY.")
    const runs = Number(values.runs ?? 50)
    if (!Number.isInteger(runs) || runs < 1)
      throw new SetupError("--runs needs a whole number of 1 or more.")
    // Each model call scrubs its text with it (ADR-072).
    buildConverter()
    const calls = modelCalls(capUsd)
    const restore = calls.install()
    try {
      await measureLatency({ out, calls, base: modelBase(), runs })
      process.stdout.write(`The report is in ${join(out, "latency.md")}.\n`)
      return calls.stopped ? 3 : 0
    } finally {
      restore()
    }
  }

  if (command === "vision") {
    if (!process.env.MODEL_PROVIDER_API_KEY)
      throw new SetupError("vision needs MODEL_PROVIDER_API_KEY.")
    // The SVG fixtures go through the converter.
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

  if (command !== "run" && command !== "rescore" && command !== "hydrate")
    throw new SetupError(
      "Use the command hydrate, run, rescore, draft, label, finalize, corpus, probe, latency or vision.",
    )
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new SetupError("Set DATABASE_URL.")
  const dataset = values.dataset
  if (command === "hydrate") {
    if (!dataset) throw new SetupError("hydrate needs --dataset.")
    if (values.set || values.kept)
      throw new SetupError("hydrate takes no --set and no --kept.")
    // The projection of the plane converts each file with it.
    buildConverter()
    initDb(databaseUrl)
    try {
      return await hydrateCommand({
        dataset: await readDataset(dataset),
        // The eval org. Its ids are made up.
        org: {
          id: "org_knowledge_eval",
          slug: "knowledge-eval",
          name: "Knowledge eval",
        },
        databaseUrl,
        out,
        capUsd,
      })
    } finally {
      await closeDb()
    }
  }
  const kept = values.kept
    ? keptRunSchema.parse(await readJson(values.kept))
    : null
  const settings = parseSettings(values.set ?? [])
  initDb(databaseUrl)
  try {
    let report: Report
    if (command === "rescore") {
      if (!values.from) throw new SetupError("rescore needs --from.")
      if (values["baseline-from"] || values["reuse-from"])
        throw new SetupError(
          "rescore takes no --baseline-from and no --reuse-from: it replays the plane of --from, and keeps its answers of the old stack.",
        )
      const fill = values["unrecorded-yes"]
      const unrecordedYes = fill === undefined ? undefined : Number(fill)
      if (
        unrecordedYes !== undefined &&
        !(fill !== "" && unrecordedYes >= 0 && unrecordedYes <= 1)
      )
        throw new SetupError("--unrecorded-yes is a number from 0 to 1.")
      const recorded = await readRun(values.from)
      // Each model call of the readers scrubs its text with it (CTX-1452).
      buildConverter()
      report = await executeRun({
        dataset: recorded.dataset,
        targets: recorded.targets,
        splits: recorded.manifest.splits,
        settings: { ...recorded.manifest.settings, ...settings },
        capUsd: 0,
        now: new Date(recorded.manifest.now),
        out,
        kept,
        replay: {
          calls: recorded.calls,
          ...(unrecordedYes === undefined ? {} : { unrecordedYes }),
        },
        quietMs: QUIET_MS,
        baseline: { folder: values.from, run: recorded },
      })
    } else {
      if (!dataset || !values.targets)
        throw new SetupError("run needs --dataset and --targets.")
      const splits: Manifest["splits"] =
        values.split === "dev" || values.split === "holdout"
          ? [values.split]
          : ["dev", "holdout"]
      if (values.split && splits.length !== 1)
        throw new SetupError("--split is dev or holdout.")
      // A changed request of a run goes out, so a run has no fill.
      if (values["unrecorded-yes"] !== undefined)
        throw new SetupError("--unrecorded-yes is for rescore only.")
      const baselineFrom = values["baseline-from"]
      // The old stack is gone (CTX-1713): its answers come from a stored run.
      if (!baselineFrom)
        throw new SetupError(
          "run needs --baseline-from: the answers of the old stack come from a stored run.",
        )
      const reuseFrom = values["reuse-from"]
      // A folder that is not a run folder is a setup error.
      const runFolder = (flag: string, folder: string) =>
        readRun(folder).catch((error: unknown) => {
          throw new SetupError(
            `${flag} ${folder} is not a run folder: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
      buildConverter()
      report = await executeRun({
        dataset: await readDataset(dataset),
        targets: targetsSchema.parse(await readJson(values.targets)),
        splits,
        settings,
        capUsd,
        now: new Date(),
        out,
        kept,
        quietMs: QUIET_MS,
        baseline: {
          folder: baselineFrom,
          run: await runFolder("--baseline-from", baselineFrom),
        },
        ...(reuseFrom
          ? {
              reuse: {
                folder: reuseFrom,
                run: await runFolder("--reuse-from", reuseFrom),
              },
            }
          : {}),
      })
    }
    process.stdout.write(`The report is in ${join(out, "report.md")}.\n`)
    if (report.run.stopped) return 3
    if (report.errors) {
      process.stderr.write(
        `${report.errors} answers have a failed call. The report lists them under "Errors".\n`,
      )
      return 1
    }
    return 0
  } finally {
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
