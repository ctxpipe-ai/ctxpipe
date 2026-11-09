// The bake-off runner of the visual critic (CTX-1202). It runs each arm (a
// judge with its settings) on each case of the case manifest, some runs each,
// and writes the results and the report. See README.md beside this file.
//
// Usage: pnpm visual:bakeoff:run --arms <list> [--images <dir>] [--out <dir>]
//          [--runs 3] [--max-cost 100] [--max-minutes <n>] [--concurrency 4]
//          [--blazediff-agent <dir>] [--cases <path>]

import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

import { judgeWithJev } from "../../src/adapters/jev.ts"
import { judgeWithOpenRouter } from "../../src/adapters/openrouter.ts"
import { judgeByModel } from "../../src/command.ts"
import { diff, type Comparison } from "../../src/compare/diff.ts"
import { writeStoryImages } from "../../src/compare/images.ts"
import {
  insideRoot,
  realInside,
  storyInput,
} from "../../src/compare/manifest.ts"
import { pngSize } from "../../src/prepare.ts"
import { reviewStories } from "../../src/review.ts"
import type { Box, StoryInput } from "../../src/story.ts"
import { parseVerdict, type Verdict } from "../../src/verdict.ts"
import { caseManifestSchema, type Case, type CaseManifest } from "./cases.ts"
import { report, type Result } from "./report.ts"

const usage = `Usage: pnpm visual:bakeoff:run --arms <list> [--images <dir>] [--out <dir>] [--runs 3] [--max-cost 100] [--max-minutes <n>] [--concurrency 4] [--blazediff-agent <dir>] [--cases <path>]

  --arms         The arms, comma-separated:
                   llm:<model>           the critic prompt (describe each side, then compare)
                   llm-one-step:<model>  the critic prompt, with a one-step comparison
                   llm-no-facts:<model>  the critic prompt, without the interpreter facts
                   jev                   Jev alone
                   decision:<model>      another decision model, with the Jev questions
                   cascade:<model>       Jev, then <model> when Jev does not accept
                   blazediff-local       the local judge of BlazeDiff (no cost)
                 <model> is an OpenRouter id, for example anthropic/claude-sonnet-5.5.
  --images       The output folder of pnpm visual:bakeoff:build, with cases/<id>/.
                 Default: .ci-results/visual-bakeoff
  --out          The folder for results.json and report.md.
                 Default: .ci-results/visual-bakeoff/report
  --runs         The runs of each arm on each case. Default: 3
  --max-cost     The spend cap in USD. No paid call starts when the cost of
                 the run reaches it. A call without a cost counts as the most
                 expensive call so far, and at least $0.10. Default: 100
  --max-minutes  No call starts after this time, so that a job writes its
                 report before its timeout. Default: no limit.
  --concurrency  The calls at the same time for each paid arm. Default: 4
  --blazediff-agent
                 A folder with @blazediff/agent and @huggingface/transformers in
                 node_modules, installed as .github/workflows/visual-bakeoff.yaml
                 does. Needed for blazediff-local.
  --cases        The case manifest. Default: cases.json beside this file.

The key and the endpoint of the paid arms come from MODEL_PROVIDER_API_KEY
and MODEL_PROVIDER_URL. Exit code: 2 for a usage or input error; else 0.`

/** One case, ready for the judges. */
type Prepared = {
  entry: Case
  story: StoryInput
  comparison: Comparison
  /** The paths of the full before and after images. */
  before: string
  after: string
  /** The known region of the case, in fractions of the after image. */
  region: Box | null
}

type Judge = (story: StoryInput, prepared: Prepared) => Promise<Verdict>

type Arm = {
  id: string
  /** True when a call costs money: the spend cap applies. */
  paid: boolean
  concurrency: number
  /**
   * The story that the arm gets. The free noise step of `reviewStories` sees
   * this story too.
   */
  input: (story: StoryInput) => StoryInput
  judge: Judge
}

/**
 * The cases of the hold-out set: 30% of each kind, the first ones in the
 * order of a hash of the seed and the case id. The same seed and the same
 * cases give the same set.
 */
export function holdOut(manifest: CaseManifest, seed: number): Set<string> {
  const rank = (id: string) =>
    createHash("sha256").update(`${seed}:${id}`).digest("hex")
  const held = new Set<string>()
  for (const kind of new Set(manifest.cases.map(({ kind }) => kind))) {
    const ofKind = manifest.cases
      .filter((entry) => entry.kind === kind)
      .map(({ id }) => ({ id, rank: rank(id) }))
      .sort((a, b) => (a.rank < b.rank ? -1 : 1))
    for (const { id } of ofKind.slice(0, Math.round(0.3 * ofKind.length)))
      held.add(id)
  }
  return held
}

/**
 * The story of the arm without the interpreter facts: each region has no
 * change type and no confidence, as when the interpreter is not available.
 * There is no signature, so the free noise step does not apply.
 */
function withoutFacts(story: StoryInput): StoryInput {
  return {
    ...story,
    signature: undefined,
    regions: story.regions.map((region) => ({
      ...region,
      changeType: null,
      confidence: 0,
    })),
  }
}

const same = (story: StoryInput) => story

/** The arm of one `--arms` entry. Throws for an unknown arm. */
async function armOf(
  id: string,
  options: { concurrency: number; blazediffAgent?: string; work: string },
): Promise<Arm> {
  const colon = id.indexOf(":")
  const kind = colon < 0 ? id : id.slice(0, colon)
  const model = colon < 0 ? "" : id.slice(colon + 1)
  const base = { id, paid: true, concurrency: options.concurrency }
  const needsModel = () => {
    if (!model) throw new Error(`Arm "${id}" needs a model: ${kind}:<model>.`)
  }
  switch (kind) {
    case "llm":
    case "llm-one-step":
    case "llm-no-facts":
      needsModel()
      return {
        ...base,
        input: kind === "llm-no-facts" ? withoutFacts : same,
        judge: (story) =>
          judgeWithOpenRouter(
            story,
            model,
            process.env,
            kind === "llm-one-step" ? "one-step" : "describe-first",
          ),
      }
    case "jev":
      if (model) throw new Error(`Arm "jev" takes no model.`)
      return { ...base, input: same, judge: (story) => judgeWithJev(story) }
    case "decision":
      needsModel()
      return {
        ...base,
        input: same,
        judge: (story) => judgeWithJev(story, model),
      }
    case "cascade":
      needsModel()
      return {
        ...base,
        input: same,
        judge: (story) => judgeByModel(story, model, "jev"),
      }
    case "blazediff-local":
      if (!options.blazediffAgent)
        throw new Error(
          "Arm blazediff-local needs --blazediff-agent <dir>: a folder with the packages that .github/workflows/visual-bakeoff.yaml installs.",
        )
      return {
        id,
        paid: false,
        concurrency: 1,
        input: same,
        judge: await blazediffLocal(options.blazediffAgent, options.work),
      }
    default:
      throw new Error(`Unknown arm "${id}".\n\n${usage}`)
  }
}

/** The part of the API of `@blazediff/agent` 0.13 that the arm uses. */
type BlazediffAgent = {
  resolveJudge(backend: "local"): {
    warmup?(): Promise<void>
    judge(
      input: {
        entry: { id: string }
        baselinePath: string
        actualPath: string
        regions: {
          bbox: { x: number; y: number; width: number; height: number }
          pixelCount: number
          percentage: number
          changeType: string
          confidence: number
        }[]
        diffPercentage: number
        severity: string
        heuristicVerdict: BlazediffVerdict
      },
      cwd: string,
    ): Promise<
      | { kind: "judged"; verdict: BlazediffVerdict; confidence?: number }
      | { kind: "deferred" }
      | { kind: "failed"; error: Error }
    >
  }
}
type BlazediffVerdict = {
  label:
    | "regression-likely"
    | "intentional-likely"
    | "noise-likely"
    | "ambiguous"
  headline: string
  rationale: string[]
  action: string
}

/**
 * The local judge of BlazeDiff: Moondream describes the before and after
 * crop of each region, and Qwen classifies the change with the interpreter
 * summary. It runs on this host, at no cost. Its labels map to the verdicts:
 * regression-likely is regression, intentional-likely is intended (only with
 * a brief, as for every judge), noise-likely is noise and ambiguous is unsure.
 * The severity of a regression comes from the interpreter: high is major, else
 * minor. It gives no qualities and no findings.
 */
async function blazediffLocal(folder: string, work: string): Promise<Judge> {
  const agent = (await import(
    pathToFileURL(
      join(resolve(folder), "node_modules/@blazediff/agent/dist/index.mjs"),
    ).href
  )) as BlazediffAgent
  const local = agent.resolveJudge("local")
  await local.warmup?.()
  const verdicts = {
    "regression-likely": "regression",
    "intentional-likely": "intended",
    "noise-likely": "noise",
    ambiguous: "unsure",
  } as const
  return async (story, { entry, comparison, before, after }) => {
    const measured = comparison.status === "size-changed" ? null : comparison
    const area = measured ? measured.size.width * measured.size.height : 1
    const started = performance.now()
    const output = await local.judge(
      {
        entry: { id: entry.id },
        baselinePath: before,
        actualPath: after,
        regions: (measured?.regions ?? []).map((region) => ({
          bbox: region.box,
          pixelCount: region.pixels,
          percentage: (100 * region.pixels) / area,
          changeType: region.changeType ?? "content-change",
          confidence: region.confidence,
        })),
        diffPercentage: measured ? (100 * measured.diffPixels) / area : 100,
        severity: measured?.severity ?? "high",
        heuristicVerdict: {
          label: "ambiguous",
          headline: "The local judge gave no label.",
          rationale: [],
          action: "investigate",
        },
      },
      work,
    )
    const run = {
      model: "blazediff-local",
      costUsd: 0,
      latencyMs: performance.now() - started,
    }
    if (output.kind !== "judged")
      return failed(
        story,
        run,
        output.kind === "failed"
          ? output.error.message
          : "The local judge deferred the case to an agent.",
      )
    const verdict = verdicts[output.verdict.label]
    return parseVerdict(
      JSON.stringify({
        observations: [],
        verdict,
        severity:
          verdict !== "regression"
            ? "none"
            : measured?.severity === "high"
              ? "major"
              : "minor",
        confidence: output.confidence ?? 0.5,
        summary: output.verdict.headline,
        qualities: [],
        findings: [],
      }),
      story,
      run,
    )
  }
}

/**
 * Compare the before and after image of each case with the compare engine,
 * and write the images for the judges into `work`. A case with no image
 * throws: the run needs every image of the manifest.
 */
async function prepare(
  manifest: CaseManifest,
  images: string,
  work: string,
): Promise<Prepared[]> {
  const prepared: Prepared[] = []
  for (const entry of manifest.cases) {
    const before = insideRoot(images, entry.images.before)
    const after = insideRoot(images, entry.images.after)
    // The images can come from an archive. A symbolic link in it must not
    // send a file outside the folder to a model provider.
    const read = async (path: string) => {
      await realInside(images, path)
      return readFile(path)
    }
    const [beforeBytes, afterBytes] = await Promise.all([
      read(before),
      read(after),
    ]).catch((error: Error) => {
      throw new Error(
        `Case ${entry.id} has no usable image in ${images}: ${error.message}`,
      )
    })
    const comparison = await diff(beforeBytes, afterBytes)
    const { images: written, omittedRegions } = await writeStoryImages(
      { root: work, dir: entry.id },
      beforeBytes,
      afterBytes,
      comparison,
    )
    const size = pngSize(afterBytes) ?? entry.viewport
    const measured =
      comparison.status === "size-changed"
        ? { regions: [], signature: null }
        : comparison
    prepared.push({
      entry,
      comparison,
      before,
      after,
      region: entry.region && {
        x: entry.region.x / size.width,
        y: entry.region.y / size.height,
        width: entry.region.width / size.width,
        height: entry.region.height / size.height,
      },
      story: storyInput({
        storyId: entry.id,
        // The case manifest has no scope. Each case is judged as a part of
        // the UI, so the page-only qualities are not judged.
        scope: "component",
        viewport: entry.viewport,
        size,
        regions: measured.regions,
        omittedRegions,
        signature: measured.signature,
        images: written,
        root: work,
        ...(entry.brief ? { brief: entry.brief } : {}),
      }),
    })
  }
  return prepared
}

/** The verdict of a pair at most the tolerance apart: noise, with no judge. */
const unchanged = (story: StoryInput): Verdict => ({
  storyId: story.storyId,
  observations: [],
  verdict: "noise",
  severity: "none",
  confidence: 1,
  summary: "The images differ by at most the tolerance. No judge was called.",
  qualities: [],
  findings: [],
  model: "none",
  costUsd: 0,
  latencyMs: 0,
})

/** The verdict of a judge that gave no verdict: `unsure`, with the error. */
const failed = (
  story: StoryInput,
  run: Pick<Verdict, "model" | "costUsd" | "latencyMs">,
  error: string,
): Verdict => ({
  storyId: story.storyId,
  observations: [],
  verdict: "unsure",
  severity: "none",
  confidence: 0,
  summary: "The judge gave no verdict.",
  qualities: [],
  findings: [],
  ...run,
  error,
})

/** A limit of the run (the spend cap or the time) stops a call. */
class Stopped extends Error {}

/**
 * Run `pnpm visual:bakeoff:run` with the command-line arguments `args`.
 * `print` gets the output. Returns the exit code.
 */
export async function bakeOff(
  args: readonly string[],
  print: (text: string) => void,
): Promise<number> {
  let options
  try {
    ;({ values: options } = parseArgs({
      args: [...args],
      strict: true,
      options: {
        arms: { type: "string" },
        images: { type: "string", default: ".ci-results/visual-bakeoff" },
        out: { type: "string", default: ".ci-results/visual-bakeoff/report" },
        runs: { type: "string", default: "3" },
        "max-cost": { type: "string", default: "100" },
        "max-minutes": { type: "string" },
        concurrency: { type: "string", default: "4" },
        "blazediff-agent": { type: "string" },
        cases: { type: "string" },
      },
    }))
  } catch (error) {
    print(`${(error as Error).message}\n\n${usage}`)
    return 2
  }
  const runs = Number(options.runs)
  const maxCost = Number(options["max-cost"])
  const concurrency = Number(options.concurrency)
  const maxMinutes = Number(options["max-minutes"] ?? Infinity)
  if (
    !options.arms ||
    !Number.isInteger(runs) ||
    runs < 1 ||
    !(maxCost >= 0) ||
    !(maxMinutes > 0) ||
    !Number.isInteger(concurrency) ||
    concurrency < 1
  ) {
    print(
      `--arms is required. --runs and --concurrency must be whole numbers of 1 or more, --max-cost a number of 0 or more, and --max-minutes a number over 0.\n\n${usage}`,
    )
    return 2
  }

  const work = await mkdtemp(join(tmpdir(), "visual-bakeoff-"))
  try {
    let manifest: CaseManifest
    let arms: Arm[]
    let prepared: Prepared[]
    try {
      manifest = caseManifestSchema.parse(
        JSON.parse(
          await readFile(
            resolve(options.cases ?? join(import.meta.dirname, "cases.json")),
            "utf8",
          ),
        ),
      )
      const ids = options.arms
        .split(",")
        .map((arm) => arm.trim())
        .filter(Boolean)
      if (new Set(ids).size !== ids.length)
        throw new Error("Each arm must be in --arms only once.")
      arms = []
      for (const id of ids)
        arms.push(
          await armOf(id, {
            concurrency,
            work,
            ...(options["blazediff-agent"]
              ? { blazediffAgent: options["blazediff-agent"] }
              : {}),
          }),
        )
      if (arms.some(({ paid }) => paid) && !process.env.MODEL_PROVIDER_API_KEY)
        throw new Error(
          "Set MODEL_PROVIDER_API_KEY (the OpenRouter key) for the paid arms.",
        )
      prepared = await prepare(manifest, resolve(options.images), work)
    } catch (error) {
      print((error as Error).message)
      return 2
    }

    const held = holdOut(manifest, manifest.seed)
    const armIds = arms.map(({ id }) => id)
    const deadline = Date.now() + maxMinutes * 60_000
    let spent = 0
    // The cost of the most expensive call so far. A call without a known
    // cost counts as this much, and at least $0.10 (more than one image call
    // of the models of the plan), so that the cap still holds.
    let highest = 0
    let stopped: "cost" | "time" | undefined
    let unknownCost = 0
    const results: Result[] = []
    const count = (cost: number | null) => {
      if (cost === null) {
        unknownCost++
        spent += Math.max(highest, 0.1)
      } else {
        spent += cost
        highest = Math.max(highest, cost)
      }
    }

    // Each call, also a retry, checks the limits first.
    const attempt = (arm: Arm, story: StoryInput, prepared: Prepared) => {
      if (arm.paid && spent >= maxCost) stopped = "cost"
      else if (Date.now() >= deadline) stopped = "time"
      else return reserved(arm, story, prepared)
      throw new Stopped()
    }
    // A paid call holds its estimated cost in the spend while it runs, so
    // that calls at the same time cannot pass the cap together.
    const reserved = async (
      arm: Arm,
      story: StoryInput,
      prepared: Prepared,
    ) => {
      const reserve = arm.paid ? Math.max(highest, 0.1) : 0
      spent += reserve
      try {
        return await arm.judge(story, prepared)
      } finally {
        spent -= reserve
      }
    }
    const judge = async (arm: Arm, story: StoryInput, prepared: Prepared) => {
      let verdict: Verdict
      try {
        verdict = await attempt(arm, story, prepared)
      } catch (error) {
        if (error instanceof Stopped) throw error
        // The cost of the failed call is not known.
        count(null)
        // One retry for a failed call (a rate limit, a timeout).
        await new Promise((done) => setTimeout(done, 5_000))
        verdict = await attempt(arm, story, prepared)
      }
      count(verdict.costUsd)
      return verdict
    }
    const runArm = async (arm: Arm, cases: readonly Prepared[]) => {
      const queue = Array.from({ length: runs }, (_, run) =>
        cases.map((prepared) => ({ run: run + 1, prepared })),
      ).flat()
      const worker = async () => {
        for (let task = queue.shift(); task; task = queue.shift()) {
          const { run, prepared } = task
          const story = arm.input(prepared.story)
          let verdict: Verdict
          try {
            // The free noise step of the critic applies before the judge.
            verdict =
              prepared.comparison.status === "unchanged"
                ? unchanged(story)
                : ((
                    await reviewStories([story], (story) =>
                      judge(arm, story, prepared),
                    )
                  )[0] ?? unchanged(story))
          } catch (error) {
            if (error instanceof Stopped) return
            // The cost of a failed call is not known.
            count(null)
            verdict = failed(
              story,
              { model: arm.id, costUsd: null, latencyMs: 0 },
              (error as Error).message,
            )
          }
          results.push({ arm: arm.id, case: prepared.entry.id, run, verdict })
        }
      }
      await Promise.all(Array.from({ length: arm.concurrency }, worker))
    }
    // All arms finish all runs of the hold-out cases before any arm starts
    // the other cases, so that a run that a limit stops has the cases of the
    // selection rule.
    for (const cases of [
      prepared.filter(({ entry }) => held.has(entry.id)),
      prepared.filter(({ entry }) => !held.has(entry.id)),
    ])
      await Promise.all(arms.map((arm) => runArm(arm, cases)))

    const text = report({
      manifest,
      holdOut: held,
      arms: armIds,
      runs,
      results,
      regions: new Map(prepared.map(({ entry, region }) => [entry.id, region])),
      stopped,
      spend: { spent, maxCost, unknownCost },
    })
    const out = resolve(options.out)
    await mkdir(out, { recursive: true })
    await writeFile(
      join(out, "results.json"),
      `${JSON.stringify({ seed: manifest.seed, runs, arms: armIds, spent, stopped: stopped ?? null, results }, null, 2)}\n`,
    )
    await writeFile(join(out, "report.md"), `${text}\n`)
    print(text)
    return 0
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

if (import.meta.main)
  process.exitCode = await bakeOff(process.argv.slice(2), (text) =>
    process.stdout.write(`${text}\n`),
  )
