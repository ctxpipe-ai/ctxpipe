// The bake-off runner of the visual critic (CTX-1202). It runs each arm (a
// judge with its settings) on each case of the case manifest, some runs each,
// and writes the results and the report. See README.md beside this file.
//
// Usage: pnpm visual:bakeoff:run --arms <list> [--images <dir>] [--out <dir>]
//          [--runs 3] [--max-cost 100] [--max-minutes <n>] [--concurrency 4]
//          [--blazediff-agent <dir>] [--cases <path>] [--release <url>]
//          [--hold-out-only]

import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

import { judgeNewWithJev, judgeWithJev } from "../../src/adapters/jev.ts"
import {
  judgeNewWithOpenRouter,
  judgeWithOpenRouter,
} from "../../src/adapters/openrouter.ts"
import { judgeByModel } from "../../src/command.ts"
import { diff, type Comparison } from "../../src/compare/diff.ts"
import { writeStoryImages } from "../../src/compare/images.ts"
import { storyInput } from "../../src/compare/manifest.ts"
import { pngSize } from "../../src/prepare.ts"
import { reviewStories } from "../../src/review.ts"
import type { Box, NewStoryInput, StoryInput } from "../../src/story.ts"
import { parseVerdict, type Verdict } from "../../src/verdict.ts"
import { caseManifestSchema, type Case, type CaseManifest } from "./cases.ts"
import { imageFile, imageStore, releaseUrl } from "./images.ts"
import { report, type Result } from "./report.ts"

const usage = `Usage: pnpm visual:bakeoff:run --arms <list> [--images <dir>] [--out <dir>] [--runs 3] [--max-cost 100] [--max-minutes <n>] [--concurrency 4] [--blazediff-agent <dir>] [--cases <path>] [--release <url>] [--hold-out-only]

  --arms         The arms, comma-separated:
                   llm:<model>           the critic prompt (describe each side, then compare)
                   llm-one-step:<model>  the critic prompt, with a one-step comparison
                   llm-no-facts:<model>  the critic prompt, without the interpreter facts
                   jev                   Jev alone
                   decision:<model>      another decision model, with the Jev questions
                   cascade:<model>       Jev, then <model> when Jev does not accept
                   cascade:<filter>+<model>
                                         the decision model <filter> instead of Jev
                   blazediff-local       the local judge of BlazeDiff (no cost)
                 <model> is an OpenRouter id, for example anthropic/claude-sonnet-5.5.
  --images       The folder of the case images, as <sha256>.png. An image that
                 is not in it comes from --release when its case runs, and
                 goes into it. Default: .ci-results/visual-bakeoff/images
  --out          The folder for results.json and report.md.
                 Default: .ci-results/visual-bakeoff/report
  --runs         The runs of each arm on each case. Default: 3
  --max-cost     The spend cap in USD. A paid call starts only when its
                 estimate (the most expensive call so far, and at least $0.10)
                 fits under it. A call without a cost counts as its estimate.
                 Default: 100
  --max-minutes  No call starts after this time, so that a job writes its
                 report before its timeout. Default: no limit.
  --concurrency  The calls at the same time for each paid arm. Default: 4
  --blazediff-agent
                 A folder with @blazediff/agent and @huggingface/transformers in
                 node_modules, installed as .github/workflows/visual-bakeoff.yaml
                 does. Needed for blazediff-local.
  --cases        The case manifest. Default: cases.json beside this file.
  --release      The URL of the release assets with the images.
                 Default: ${releaseUrl}
  --hold-out-only
                 Run only the cases of the hold-out set.

The key and the endpoint of the paid arms come from MODEL_PROVIDER_API_KEY
and MODEL_PROVIDER_URL. Exit code: 2 for a usage or input error, also a
missing or changed image; else 0.`

/** One case of a change, ready for the judges. */
type Prepared = {
  kind: "change"
  entry: Case
  story: StoryInput
  comparison: Comparison
  /** The paths of the full before and after images. */
  before: string
  after: string
  /** The known region of the case, in fractions of the after image. */
  region: Box | null
}

/** One `new` case, ready for the judges of a new screenshot. */
type PreparedNew = {
  kind: "new"
  entry: Case
  newStory: NewStoryInput
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
  /**
   * The judge of a new screenshot, as `pnpm visual:review` judges one.
   * Absent when the arm cannot judge one: the report says "not applicable".
   */
  judgeNew?: (story: NewStoryInput) => Promise<Verdict>
}

/**
 * The cases of the hold-out set: 30% of each kind of change, the first ones
 * in the order of a hash of the seed and the case id. The same seed and the
 * same cases give the same set. A `new` case is not a change: the selection
 * rule does not use it, so it is not in the set.
 */
export function holdOut(manifest: CaseManifest, seed: number): Set<string> {
  const rank = (id: string) =>
    createHash("sha256").update(`${seed}:${id}`).digest("hex")
  const held = new Set<string>()
  for (const kind of new Set(manifest.cases.map(({ kind }) => kind))) {
    if (kind === "new") continue
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
        // A new screenshot has no steps and no interpreter facts: the three
        // prompt arms get the same prompt for it.
        judgeNew: (story) => judgeNewWithOpenRouter(story, model, process.env),
      }
    case "jev":
      if (model) throw new Error(`Arm "jev" takes no model.`)
      return {
        ...base,
        input: same,
        judge: (story) => judgeWithJev(story),
        judgeNew: (story) => judgeNewWithJev(story),
      }
    case "decision":
      needsModel()
      return {
        ...base,
        input: same,
        judge: (story) => judgeWithJev(story, model),
        judgeNew: (story) => judgeNewWithJev(story, model),
      }
    case "cascade": {
      needsModel()
      const [filter, explainer] = model.includes("+")
        ? model.split("+", 2)
        : [undefined, model]
      if (!explainer) throw new Error(`Arm "${id}" needs a model after the +.`)
      return {
        ...base,
        input: same,
        judge: (story) => judgeByModel(story, explainer, "jev", filter),
        // `pnpm visual:review --filter jev` sends a new screenshot to the
        // model, never to the filter.
        judgeNew: (story) =>
          judgeNewWithOpenRouter(story, explainer, process.env),
      }
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
 * Get the images of `cases` (images.ts), compare the before and after image
 * of each case with the compare engine, and write the images for the judges
 * into `work`. A `new` case has only its after image, which goes to `work` as
 * it is. A case with no image, or with an image that does not have its
 * SHA-256, throws.
 */
async function prepare(
  cases: readonly Case[],
  images: string,
  release: string,
  work: string,
): Promise<(Prepared | PreparedNew)[]> {
  const prepared: (Prepared | PreparedNew)[] = []
  const get = imageStore(images, release)
  const read = async (entry: Case, sha256: string) => {
    try {
      return await get(sha256)
    } catch (error) {
      throw new Error(
        `Case ${entry.id} has no usable image: ${(error as Error).message}`,
      )
    }
  }
  for (const entry of cases) {
    if (entry.kind === "new") {
      const bytes = await read(entry, entry.images.after)
      const size = pngSize(bytes)
      if (!size)
        throw new Error(`The image of the new case ${entry.id} is not a PNG.`)
      const path = join(work, entry.id, "after.png")
      await mkdir(join(work, entry.id), { recursive: true })
      await writeFile(path, bytes)
      prepared.push({
        kind: "new",
        entry,
        newStory: {
          storyId: entry.id,
          // As for a change: each case is judged as a part of the UI.
          scope: "component",
          images: [{ path, size }],
          brief: entry.brief,
        },
      })
      continue
    }
    const [beforeBytes, afterBytes] = await Promise.all([
      read(entry, entry.images.before),
      read(entry, entry.images.after),
    ])
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
      kind: "change",
      entry,
      comparison,
      before: join(images, imageFile(entry.images.before)),
      after: join(images, imageFile(entry.images.after)),
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
  story: Pick<StoryInput, "storyId">,
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
        images: {
          type: "string",
          default: ".ci-results/visual-bakeoff/images",
        },
        release: { type: "string", default: releaseUrl },
        "hold-out-only": { type: "boolean", default: false },
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
    let held: Set<string>
    let arms: Arm[]
    let prepared: (Prepared | PreparedNew)[]
    // The cases of the run, in two parts: the hold-out cases, then the
    // others. A part gets its images only when it starts.
    let parts: Case[][]
    const images = resolve(options.images)
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
      // The hold-out set comes from all cases, so that a label of the owner
      // does not move other cases in or out of it. A case that the owner
      // labeled unsure has no answer, so it does not run.
      held = holdOut(manifest, manifest.seed)
      const cases = manifest.cases.filter(
        ({ id, label }) =>
          label !== "unsure" && (held.has(id) || !options["hold-out-only"]),
      )
      manifest = { ...manifest, cases }
      parts = [
        cases.filter(({ id }) => held.has(id)),
        cases.filter(({ id }) => !held.has(id)),
      ]
      prepared = await prepare(parts[0] ?? [], images, options.release, work)
    } catch (error) {
      print((error as Error).message)
      return 2
    }

    const armIds = arms.map(({ id }) => id)
    const deadline = Date.now() + maxMinutes * 60_000
    let spent = 0
    let highest = 0
    // The estimate of a paid call: the most expensive call so far, and at
    // least $0.10 (more than one image call of the models of the plan). A
    // call without a known cost counts as this much.
    const estimate = () => Math.max(highest, 0.1)
    let stopped: "cost" | "time" | "image" | undefined
    let unknownCost = 0
    const results: Result[] = []
    const count = (cost: number | null) => {
      if (cost === null) {
        unknownCost++
        spent += estimate()
      } else {
        spent += cost
        highest = Math.max(highest, cost)
      }
    }

    // Each call, also a retry, checks the limits first. A paid call starts
    // only when its estimate fits under the cap.
    const attempt = (arm: Arm, call: () => Promise<Verdict>) => {
      if (arm.paid && spent + estimate() > maxCost) stopped = "cost"
      else if (Date.now() >= deadline) stopped = "time"
      else return reserved(arm, call)
      throw new Stopped()
    }
    // A paid call holds its estimated cost in the spend while it runs, so
    // that calls at the same time cannot pass the cap together.
    const reserved = async (arm: Arm, call: () => Promise<Verdict>) => {
      const reserve = arm.paid ? estimate() : 0
      spent += reserve
      try {
        return await call()
      } finally {
        spent -= reserve
      }
    }
    const judge = async (arm: Arm, call: () => Promise<Verdict>) => {
      let verdict: Verdict
      try {
        verdict = await attempt(arm, call)
      } catch (error) {
        if (error instanceof Stopped) throw error
        // The cost of the failed call is not known.
        count(null)
        // One retry for a failed call (a rate limit, a timeout).
        await new Promise((done) => setTimeout(done, 5_000))
        verdict = await attempt(arm, call)
      }
      count(verdict.costUsd)
      return verdict
    }
    const runArm = async (
      arm: Arm,
      cases: readonly (Prepared | PreparedNew)[],
    ) => {
      const queue = Array.from({ length: runs }, (_, run) =>
        cases.map((prepared) => ({ run: run + 1, prepared })),
      ).flat()
      const worker = async () => {
        for (let task = queue.shift(); task; task = queue.shift()) {
          const { run, prepared } = task
          const pending = verdictOf(arm, prepared)
          if (!pending) continue
          let verdict: Verdict
          try {
            verdict = await pending
          } catch (error) {
            if (error instanceof Stopped) return
            // The cost of a failed call is not known.
            count(null)
            verdict = failed(
              { storyId: prepared.entry.id },
              { model: arm.id, costUsd: null, latencyMs: 0 },
              (error as Error).message,
            )
          }
          results.push({ arm: arm.id, case: prepared.entry.id, run, verdict })
        }
      }
      await Promise.all(Array.from({ length: arm.concurrency }, worker))
    }
    // The verdict of `arm` on one case, or undefined when the arm cannot
    // judge a new screenshot: the report says "not applicable".
    const verdictOf = (arm: Arm, prepared: Prepared | PreparedNew) => {
      if (prepared.kind === "change") return verdictOnChange(arm, prepared)
      const { judgeNew } = arm
      return judgeNew && judge(arm, () => judgeNew(prepared.newStory))
    }
    const verdictOnChange = async (arm: Arm, prepared: Prepared) => {
      const story = arm.input(prepared.story)
      // The free noise step of the critic applies before the judge.
      if (prepared.comparison.status === "unchanged") return unchanged(story)
      return (
        (
          await reviewStories([story], (story) =>
            judge(arm, () => arm.judge(story, prepared)),
          )
        )[0] ?? unchanged(story)
      )
    }
    // All arms finish all runs of the hold-out cases before any arm starts
    // the other cases, so that a run that a limit stops has the cases of the
    // selection rule. The other cases get their images only when a call can
    // still start.
    await Promise.all(arms.map((arm) => runArm(arm, prepared)))
    const limit =
      Date.now() >= deadline
        ? "time"
        : arms.every(({ paid }) => paid && spent + estimate() > maxCost)
          ? "cost"
          : undefined
    if (limit && parts[1]?.length) stopped ??= limit
    else if (parts[1]?.length) {
      let others: (Prepared | PreparedNew)[] = []
      try {
        others = await prepare(parts[1], images, options.release, work)
      } catch (error) {
        // The report keeps the verdicts on the hold-out cases.
        print((error as Error).message)
        stopped = "image"
      }
      prepared.push(...others)
      await Promise.all(arms.map((arm) => runArm(arm, others)))
    }

    const text = report({
      manifest,
      holdOut: held,
      arms: armIds,
      newArms: arms.filter(({ judgeNew }) => judgeNew).map(({ id }) => id),
      runs,
      results,
      regions: new Map(
        prepared.flatMap((prepared) =>
          prepared.kind === "change"
            ? [[prepared.entry.id, prepared.region] as const]
            : [],
        ),
      ),
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
    // A bad image is an error of the input, also when it stops a run late.
    return stopped === "image" ? 2 : 0
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

if (import.meta.main)
  process.exitCode = await bakeOff(process.argv.slice(2), (text) =>
    process.stdout.write(`${text}\n`),
  )
