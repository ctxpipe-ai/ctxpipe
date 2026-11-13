// `pnpm visual:review`: the visual critic for one visual run. It reads the
// manifest of the run, reviews each changed story (see `reviewStories`) and
// each new story (see `judgeNewScreenshots`), and prints one verdict for each
// story or group. With `--images`, it reads the
// base and head images of the factory review folder instead, and prints one
// verdict for each path (the visual critic of `critics.json`). A fork can run it with no
// factory: `--judge model` and `--judge jev` use the key of the contributor,
// and `--judge agent` lets the coding agent of the contributor judge, at no
// cost. The factory runs `--judge jev` (ADR-063).
import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, posix, resolve } from "node:path"
import { parseArgs } from "node:util"

import { judgeNewWithJev, judgeWithJev } from "./adapters/jev.ts"
import {
  judgeNewWithOpenRouter,
  judgeWithOpenRouter,
} from "./adapters/openrouter.ts"
import { diff } from "./compare/diff.ts"
import { writeStoryImages } from "./compare/images.ts"
import {
  insideRoot,
  manifestSchema,
  realInside,
  storyInput,
  toStoryInput,
} from "./compare/manifest.ts"
import { pngSize, prepareImage } from "./prepare.ts"
import { buildNewPrompt, buildPrompt, type Prompt } from "./prompt.ts"
import { reviewStories } from "./review.ts"
import { storiesOf } from "./story-tags.ts"
import type { NewStoryInput, StoryInput } from "./story.ts"
import {
  parseNewVerdict,
  parseVerdict,
  type RunFacts,
  type Verdict,
} from "./verdict.ts"

const defaultModel = "anthropic/claude-sonnet-5.5"

// The cost that a model call with no `usage.cost` in its reply counts for in
// `--budget-usd`. It is above the cost of one call of the default model with
// five images at the largest side that the critic sends.
const unknownCallUsd = 0.25
// The same for a Jev call: above the most that one Jev call cost in the
// bake-off ($0.0008), so that one reply with no cost does not use the budget
// of a whole run (ADR-063).
const unknownJevCallUsd = 0.002

const usage = `Usage: pnpm visual:review [--manifest <path>] [--judge model|jev|agent] [--model <id>] [--filter jev|none] [--budget-usd <n>] [--brief <file>] [--session <folder>] [--json]
       pnpm visual:review --images <folder> [--judge model|jev] [--model <id>] [--filter jev|none] [--budget-usd <n>] [--brief <file>] [--json] -- <path>...

  --manifest  The manifest of the visual run. Default: .ci-results/visual/manifest.json
              The command judges each changed story, and each new story on
              its own against the rubric (see --images).
  --images    A folder with base/<path> and head/<path> for each screenshot
              path after --, as the factory writes it. The command compares
              each pair with its own compare engine and gives one verdict for
              each path, with "path". A new screenshot (no base image) is
              judged on its own against the rubric: one call for the new
              screenshots of one story, at all its viewports. A removed
              screenshot is unsure. Only with --judge model or jev. Without
              MODEL_PROVIDER_API_KEY, the exit code is 2, also when no
              screenshot needs a model.
  --budget-usd The most that the model calls of this run can spend, in USD.
              Before each call, the command adds the cost of the calls so far:
              usage.cost of each reply, or for a reply with no cost
              ${unknownCallUsd} (${unknownJevCallUsd} for a Jev call). When that sum reaches the budget, it makes no more calls:
              each screenshot that is not judged yet is unsure with the error
              "Budget reached", and the exit code is 2. The exit code is 2
              also when the last call reaches the budget. Thus a run spends at
              most the budget plus one call. The new screenshots are judged
              first. Only with --judge model or jev. Default: no budget.
  --judge     model: a vision model through OpenRouter, with MODEL_PROVIDER_API_KEY
              (and MODEL_PROVIDER_URL). jev: Jev 1.14 through the OpenRouter
              Decisions API, with the same key, and no explainer: the verdict
              of Jev is the final verdict, also for a new screenshot. A Jev
              regression has severity major, so it blocks. The visual critic
              of the factory uses jev (ADR-063). agent: write a judgment request for each
              story; your coding agent writes its verdict.json; run again to read it.
              Default: model.
  --model     The explainer model of --judge model. Default: ${defaultModel}
  --filter    jev: ask the Jev filter first, and call the explainer only when Jev
              does not accept the change. Only with --judge model. A new
              screenshot goes to the explainer. Default: none.
  --brief     A file with the ticket or the brief of the change. Without it, no
              verdict can be intended.
  --session   Only with --judge agent: the folder that the first call made and
              printed. Without it, the call makes a new folder and reads no
              verdict.
  --json      Print the verdicts as one JSON array.

Exit code: 2 when the review is not complete (a usage, manifest or image
error, a verdict with an error, a budget that is reached, or an agent judgment
that is not written yet); else 1
when a verdict is regression with severity major or blocker; else 0.

The agent judge keeps its requests and verdicts in a new private folder in the
temporary folder of the system, never in the run folder or the checkout: PR
code can write those. It reads a verdict only from a folder that it made.`

/**
 * Run `visual:review` with the command-line arguments `args`. `print` gets
 * the output. The key and the endpoint of the model come from `process.env`.
 * Returns the exit code.
 */
export async function visualReview(
  args: readonly string[],
  print: (text: string) => void,
  printError: (text: string) => void = (text) =>
    process.stderr.write(`${text}\n`),
): Promise<number> {
  let options
  let paths: string[]
  try {
    ;({ values: options, positionals: paths } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: {
        manifest: { type: "string" },
        images: { type: "string" },
        judge: { type: "string", default: "model" },
        model: { type: "string", default: defaultModel },
        filter: { type: "string", default: "none" },
        brief: { type: "string" },
        session: { type: "string" },
        "budget-usd": { type: "string" },
        json: { type: "boolean", default: false },
      },
    }))
  } catch (error) {
    print(`${(error as Error).message}\n\n${usage}`)
    return 2
  }
  const { judge, filter, model } = options
  const limit = options["budget-usd"]
  const budget: Budget = {
    limitUsd: limit === undefined ? undefined : Number(limit),
    spentUsd: 0,
  }
  // A very long digit string is Infinity, which would turn the budget off.
  if (
    limit !== undefined &&
    (judge === "agent" ||
      !/^\d+(\.\d+)?$/.test(limit) ||
      !Number.isFinite(budget.limitUsd))
  ) {
    print(
      `--budget-usd must be a finite number of USD, 0 or more, and it goes only with --judge model or jev.\n\n${usage}`,
    )
    return 2
  }
  // The paid judges: `--judge jev` asks only Jev, `--judge model` the
  // explainer (after the Jev filter, if asked, for a change).
  const judgeNewByModel = async (story: NewStoryInput) =>
    (await paid(
      budget,
      () =>
        judge === "jev"
          ? judgeNewWithJev(story)
          : judgeNewWithOpenRouter(story, model, process.env),
      judge === "jev" ? unknownJevCallUsd : unknownCallUsd,
    )) ?? budgetReached(story.storyId, budget)
  if (
    (judge !== "model" && judge !== "jev" && judge !== "agent") ||
    (filter !== "jev" && filter !== "none") ||
    (judge !== "model" && filter === "jev") ||
    (judge !== "agent" && options.session !== undefined) ||
    (options.images !== undefined) !== paths.length > 0 ||
    (options.images !== undefined &&
      (options.manifest !== undefined || judge === "agent"))
  ) {
    print(
      `--judge must be model, jev or agent, and --filter must be jev or none (jev only with --judge model, --session only with --judge agent). --images needs the paths after --, and only goes with --judge model or jev and no --manifest.\n\n${usage}`,
    )
    return 2
  }
  const judgeChangedByModel = async (story: StoryInput) =>
    judge === "jev"
      ? ((await paid(budget, () => judgeWithJev(story), unknownJevCallUsd)) ??
        budgetReached(story.storyId, budget))
      : judgeByModel(story, model, filter, undefined, budget)

  if (options.images !== undefined) {
    // The factory runs this mode as the visual critic. A missing key is an
    // ERROR there, never a pass, also when no screenshot needs a model.
    if (!process.env.MODEL_PROVIDER_API_KEY) {
      print(
        "Set MODEL_PROVIDER_API_KEY (the OpenRouter key). The visual critic needs it for each review.",
      )
      return 2
    }
    // A private folder for the images of the compare engine. PR code
    // cannot write it.
    const work = await mkdtemp(
      join(await realpath(tmpdir()), "visual-review-images-"),
    )
    try {
      let screenshots: Screenshot[]
      let brief: string | undefined
      try {
        brief =
          options.brief === undefined
            ? undefined
            : await readFile(resolve(options.brief), "utf8")
        screenshots = await compareImages(
          resolve(options.images),
          paths,
          work,
          brief,
        )
      } catch (error) {
        print((error as Error).message)
        return 2
      }
      let judged: Verdict[]
      try {
        // New UI first: when the budget is short, it gets the calls.
        judged = [
          ...(await judgeNewScreenshots(
            screenshots.flatMap(({ fresh }) => (fresh ? [fresh] : [])),
            brief,
            judgeNewByModel,
          )),
          ...(await reviewStories(
            screenshots.flatMap(({ story }) => (story ? [story] : [])),
            judgeChangedByModel,
          )),
        ]
      } catch (error) {
        print(`The review stopped: ${(error as Error).message}`)
        return 2
      }
      const byPath = new Map(
        judged.map((verdict) => [verdict.storyId, verdict]),
      )
      const verdicts = screenshots.map(({ path, verdict, note }) => {
        const found = verdict ?? byPath.get(path)
        if (!found) throw new Error(`No verdict for ${path}.`)
        return {
          ...found,
          ...(note ? { summary: `${found.summary} ${note}` } : {}),
          path,
        }
      })
      return finish(verdicts, options.json, { print, printError }, budget)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  let stories: StoryInput[]
  const fresh: NewShot[] = []
  const path = resolve(options.manifest ?? ".ci-results/visual/manifest.json")
  const root = dirname(path)
  let brief: string | undefined
  let briefText: string | undefined
  try {
    // The manifest can come from an artifact that PR code wrote. A link
    // there could make this command read, and print, a file outside the run.
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("The manifest is a symbolic link. Give the real file.")
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    )
    brief = options.brief === undefined ? undefined : resolve(options.brief)
    briefText = brief === undefined ? undefined : await readFile(brief, "utf8")
    // The critic judges a change beyond the tolerance, and a new screenshot
    // on its own. A removed, unstable or failed story is the job of the
    // visual check.
    const reviewed = manifest.stories.filter(
      ({ status }) => status === "changed" || status === "size-changed",
    )
    const realRoot = await realpath(root)
    for (const story of manifest.stories) {
      if (story.status !== "new" || !story.images.after) continue
      const file = insideRoot(root, story.images.after)
      await realInside(realRoot, file)
      const size = pngSize(await readFile(file))
      if (!size)
        throw new Error(`The image of the new story ${story.id} is not a PNG.`)
      const key = `${story.id}${story.snapshot ? `@${story.snapshot}` : ""}`
      fresh.push({
        id: `${key}.${story.viewport}`,
        key,
        scope: story.scope,
        image: { path: file, size },
      })
    }
    stories = []
    for (const story of reviewed) {
      if (!story.images.before || !story.images.after)
        throw new Error(
          `Story ${story.id} is ${story.status}, but it has no before and after image.`,
        )
      const input = toStoryInput(manifest, story, {
        root,
        ...(briefText === undefined ? {} : { brief: briefText }),
      })
      // `toStoryInput` checks the paths as text. A symbolic link in the run
      // folder can still point outside it, so check the real paths too.
      for (const { path } of input.images) await realInside(realRoot, path)
      // One story can have more than one screenshot: a viewport each, and
      // named snapshots. The verdict is for one screenshot.
      stories.push({
        ...input,
        storyId: `${story.id}${story.snapshot ? `@${story.snapshot}` : ""}.${story.viewport}`,
      })
    }
  } catch (error) {
    print(`Cannot read the manifest ${path}: ${(error as Error).message}`)
    return 2
  }

  let verdicts: Verdict[]
  try {
    let agent: Parameters<typeof judgeByAgent>[1] | undefined
    if (judge === "agent") {
      const session =
        options.session === undefined
          ? await mkdtemp(join(await realpath(tmpdir()), "visual-review-"))
          : await ownSession(options.session)
      // The next call runs this file again by its absolute path, not the
      // `visual:review` of the folder where the agent happens to be: that can
      // be the checkout of a PR.
      const rerun = [
        "node",
        quote(import.meta.filename),
        "--judge agent",
        ...["--manifest", path, "--session", session].map(quote),
        ...(brief === undefined ? [] : ["--brief", quote(brief)]),
      ].join(" ")
      agent = { session, rerun, read: options.session !== undefined }
    }
    verdicts = [
      ...(await judgeNewScreenshots(
        fresh,
        briefText,
        agent
          ? (story) =>
              judgeByAgent(
                {
                  storyId: story.storyId,
                  prompt: buildNewPrompt(story),
                  parse: (reply, run) => parseNewVerdict(reply, story, run),
                },
                agent,
              )
          : judgeNewByModel,
      )),
      ...(await reviewStories(
        stories,
        agent
          ? (story) =>
              judgeByAgent(
                {
                  storyId: story.storyId,
                  prompt: buildPrompt(story),
                  parse: (reply, run) => parseVerdict(reply, story, run),
                },
                agent,
              )
          : judgeChangedByModel,
      )),
    ]
  } catch (error) {
    print(`The review stopped: ${(error as Error).message}`)
    return 2
  }
  return finish(verdicts, options.json, { print, printError }, budget)
}

/**
 * Print the verdicts, and return the exit code. A run whose spend reached its
 * budget exits with code 2, also when its last call judged the last
 * screenshot: the run used all of its budget, so it is never a pass. With
 * `--json`, the reason goes to `printError` (stderr), so that stdout stays one
 * JSON array.
 */
function finish(
  verdicts: readonly Verdict[],
  json: boolean,
  { print, printError }: Record<"print" | "printError", (text: string) => void>,
  { limitUsd, spentUsd }: Budget,
): number {
  const reached = limitUsd !== undefined && spentUsd >= limitUsd
  const reason = `Budget reached: the run spent ${spentUsd.toFixed(4)} USD of its --budget-usd ${limitUsd}.`
  if (json) {
    print(JSON.stringify(verdicts, null, 2))
    if (reached) printError(reason)
  } else print(`${report(verdicts)}${reached ? `\n${reason}` : ""}`)
  if (reached || verdicts.some(({ error }) => error !== undefined)) return 2
  if (verdicts.some(blocks)) return 1
  return 0
}

/**
 * The spend of the model calls of one run, against its `--budget-usd`
 * (`limitUsd`, undefined for no budget).
 */
type Budget = { limitUsd: number | undefined; spentUsd: number }

/**
 * Make the model call `call` when the spend of the run is under its budget,
 * and add the cost of the call: `costUsd` of the verdict, or `unknownUsd`
 * when the cost is unknown. Returns undefined, with no call, when the spend
 * has reached the budget.
 */
async function paid(
  budget: Budget,
  call: () => Promise<Verdict>,
  unknownUsd: number,
): Promise<Verdict | undefined> {
  if (budget.limitUsd !== undefined && budget.spentUsd >= budget.limitUsd)
    return undefined
  const verdict = await call()
  budget.spentUsd += verdict.costUsd ?? unknownUsd
  return verdict
}

/** The verdict on a story that got no model call: the budget is reached. */
const budgetReached = (
  storyId: string,
  { spentUsd, limitUsd }: Budget,
  costUsd: number | null = 0,
): Verdict => ({
  storyId,
  observations: [],
  verdict: "unsure",
  severity: "none",
  confidence: 0,
  summary: "Budget reached: no model judged this screenshot.",
  qualities: [],
  findings: [],
  model: "none",
  costUsd,
  latencyMs: 0,
  error: `Budget reached: the run spent ${spentUsd.toFixed(4)} USD of its --budget-usd ${limitUsd}, so it made no more model calls.`,
})

/**
 * The model judge: the explainer `model`, after the Jev filter if asked (the
 * cascade). The bake-off runs the same cascade, also with another decision
 * model (`filterModel`) as the filter. Each call is inside `budget` (default:
 * no budget).
 */
export async function judgeByModel(
  story: StoryInput,
  model: string,
  filter: "jev" | "none",
  filterModel?: string,
  budget: Budget = { limitUsd: undefined, spentUsd: 0 },
): Promise<Verdict> {
  const filtered =
    filter === "jev"
      ? await paid(
          budget,
          () => judgeWithJev(story, filterModel),
          unknownJevCallUsd,
        )
      : undefined
  if (filter === "jev" && !filtered) return budgetReached(story.storyId, budget)
  // Jev says intended only when nothing got worse and a brief or a source
  // diff explains the change: then no explainer is needed.
  if (filtered?.verdict === "intended" && !filtered.error) return filtered
  const explained = await paid(
    budget,
    () => judgeWithOpenRouter(story, model, process.env),
    unknownCallUsd,
  )
  if (!explained)
    return budgetReached(story.storyId, budget, filtered ? filtered.costUsd : 0)
  if (!filtered) return explained
  return {
    ...explained,
    costUsd:
      explained.costUsd === null || filtered.costUsd === null
        ? null
        : explained.costUsd + filtered.costUsd,
    latencyMs: explained.latencyMs + filtered.latencyMs,
  }
}

/**
 * One screenshot of `--images`: the story for the judge, a new screenshot
 * for the judge, or a verdict that needs no judge.
 */
type Screenshot = {
  path: string
  story?: StoryInput
  fresh?: NewShot
  verdict?: Verdict
  /** Added to the summary of the verdict. */
  note?: string
}

/**
 * One new screenshot: the id of its verdict, the key of its story (the id
 * without the viewport), its scope, and its head image.
 */
type NewShot = {
  id: string
  key: string
  scope: StoryInput["scope"]
  image: NewStoryInput["images"][number]
}

/**
 * Judge the new screenshots `shots` on their own against the rubric. The new
 * screenshots of one story (the same key) go to `judge` in one call. The
 * first screenshot of a story gets the verdict of the call. Each other one
 * gets a copy with `groupedWith` and no evidence of its own, as a group of
 * `reviewStories`.
 */
async function judgeNewScreenshots(
  shots: readonly NewShot[],
  brief: string | undefined,
  judge: (story: NewStoryInput) => Promise<Verdict>,
): Promise<Verdict[]> {
  const stories = new Map<string, [NewShot, ...NewShot[]]>()
  for (const shot of shots) {
    const group = stories.get(shot.key)
    if (group) group.push(shot)
    else stories.set(shot.key, [shot])
  }
  const verdicts: Verdict[] = []
  for (const [first, ...rest] of stories.values()) {
    const verdict = await judge({
      storyId: first.id,
      scope: first.scope,
      images: [first, ...rest].map(({ image }) => image),
      ...(brief === undefined ? {} : { brief }),
    })
    verdicts.push(verdict)
    // A copy keeps the verdict and the error of the call, but not its
    // evidence: a finding box is in fractions of one of the images.
    for (const { id } of rest)
      verdicts.push({
        ...verdict,
        storyId: id,
        observations: [],
        qualities: [],
        findings: [],
        costUsd: 0,
        latencyMs: 0,
        groupedWith: first.id,
        summary: `One verdict for the story at each viewport, with ${first.id}: ${verdict.summary}`,
      })
  }
  return verdicts
}

/**
 * The scope of the screenshot `path`
 * (`<dir>/screenshots/<story file>.<story>[@<snapshot>].<viewport>.screenshot.png`):
 * `page` when its story in `<dir>/<story file>.stories.tsx` of the current
 * folder (the merge-base tree) has the page tag. When that story is not
 * there, the scope is `component`, with a note that says so.
 */
async function scopeOf(
  path: string,
): Promise<{ scope: StoryInput["scope"]; note?: string }> {
  const name = /^(.+)\.(?:desktop|mobile)\.screenshot\.png$/.exec(
    posix.basename(path),
  )?.[1]
  const dir = posix.dirname(posix.dirname(path))
  // A story file name can have dots (`-github.link.stories.tsx`), so each
  // dot can end the story file part of the name.
  const candidates: { file: string; story: string }[] = []
  for (let dot = name?.indexOf(".") ?? -1; name && dot > 0;) {
    candidates.push({
      file: posix.join(dir, `${name.slice(0, dot)}.stories.tsx`),
      story: name.slice(dot + 1).split("@")[0] ?? "",
    })
    dot = name.indexOf(".", dot + 1)
  }
  const { loadCsf } = await import("storybook/internal/csf-tools")
  for (const { file, story } of candidates) {
    // A story file that is not there, or that does not parse, is not the
    // story file of this screenshot.
    const found = await readFile(insideRoot(process.cwd(), file), "utf8")
      .then((code) =>
        storiesOf(loadCsf, file, code).find(({ name }) => name === story),
      )
      .catch(() => undefined)
    if (found) return { scope: found.page ? "page" : "component" }
  }
  const files = candidates.map(({ file }) => file).join(" or ")
  return {
    scope: "component",
    note: `The scope is component: the story of this screenshot is not in ${files || "a story file"} at the merge base, so the page-only qualities were not judged.`,
  }
}

/**
 * Compare the base and the head image of each path in `folder`
 * (`base/<path>` and `head/<path>`, the review folder of the factory) with
 * the compare engine. The images for the judge go into `work`. Thus the
 * command builds its own manifest: the branch cannot label a region as
 * rendering noise.
 * - A path with no base image is a new screenshot: its head image goes into
 *   `work` for `judgeNewScreenshots`. A path with no head image is a removed
 *   screenshot. It is `unsure`: a person looks at it.
 * - A path whose images differ by at most the tolerance of the visual check
 *   is `noise`.
 * - Another path gets a story for the judge. Its story id is the path.
 * A path with no image, a path outside `folder`, and an image that is a
 * symbolic link throw.
 */
async function compareImages(
  folder: string,
  paths: readonly string[],
  work: string,
  brief: string | undefined,
): Promise<Screenshot[]> {
  const screenshots: Screenshot[] = []
  for (const [index, path] of paths.entries()) {
    try {
      const read = async (side: "base" | "head") => {
        const file = insideRoot(join(folder, side), path)
        const info = await lstat(file).catch(() => undefined)
        if (!info) return undefined
        if (!info.isFile()) throw new Error(`${file} is not a regular file.`)
        await realInside(folder, file)
        return readFile(file)
      }
      const [before, after] = [await read("base"), await read("head")]
      const plain = (verdict: Verdict["verdict"], summary: string) => ({
        path,
        verdict: {
          storyId: path,
          observations: [],
          verdict,
          severity: "none" as const,
          confidence: 1,
          summary,
          qualities: [],
          findings: [],
          model: "none",
          costUsd: 0,
          latencyMs: 0,
        },
      })
      if (!before) {
        if (!after)
          throw new Error(`${folder} has no base and no head image of it.`)
        const size = pngSize(after)
        if (!size) throw new Error("The head image is not a PNG.")
        const head = join(work, `${index}-new.png`)
        await writeFile(head, after)
        const key = path.replace(/\.(?:desktop|mobile)\.screenshot\.png$/, "")
        const found = await scopeOf(path)
        // A new story is not in the merge-base tree. Only a page story has a
        // mobile screenshot (see `runVisual` in compare/baselines.ts), so a new mobile
        // screenshot of the story makes its scope page.
        const { scope, note } =
          found.note && paths.includes(`${key}.mobile.screenshot.png`)
            ? {
                scope: "page" as const,
                note: "The scope is page: the story of this screenshot is not at the merge base, and it has a mobile screenshot, which only a page story has.",
              }
            : found
        screenshots.push({
          path,
          ...(note ? { note } : {}),
          fresh: { id: path, key, scope, image: { path: head, size } },
        })
        continue
      }
      if (!after) {
        screenshots.push(
          plain(
            "unsure",
            "The screenshot was removed: there is no head image to compare. A person looks at it.",
          ),
        )
        continue
      }
      const comparison = await diff(before, after)
      if (comparison.status === "unchanged") {
        screenshots.push(
          plain(
            "noise",
            `${comparison.diffPixels} pixels differ, which is in the tolerance of the visual check. No model judged it.`,
          ),
        )
        continue
      }
      const { images, omittedRegions } = await writeStoryImages(
        { root: work, dir: String(index) },
        before,
        after,
        comparison,
      )
      const measured =
        comparison.status === "size-changed"
          ? { size: comparison.after, regions: [], signature: null }
          : comparison
      const { scope, note } = await scopeOf(path)
      screenshots.push({
        path,
        ...(note ? { note } : {}),
        story: storyInput({
          storyId: path,
          scope,
          viewport: measured.size,
          size: measured.size,
          regions: measured.regions,
          omittedRegions,
          signature: measured.signature,
          images,
          root: work,
          brief,
        }),
      })
    } catch (error) {
      throw new Error(
        `Cannot read the image of ${path}: ${(error as Error).message}`,
      )
    }
  }
  return screenshots
}

/** The blocking rule of the product owner. */
const blocks = ({ verdict, severity }: Verdict) =>
  verdict === "regression" && (severity === "major" || severity === "blocker")

/** A word for the shell, in single quotes when it needs them. */
const quote = (word: string) =>
  /^[\w./@:=-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`

/**
 * The real path of `path` when it is a folder that `visual:review` made for
 * an agent session: a direct child `visual-review-*` of the temporary folder,
 * not a symbolic link, owned by this user, and closed to other users. Else it
 * throws. Thus PR code cannot give the folder that holds the verdicts.
 */
async function ownSession(path: string): Promise<string> {
  const info = await lstat(path)
  const real = await realpath(path)
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    dirname(real) !== (await realpath(tmpdir())) ||
    !basename(real).startsWith("visual-review-") ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      `--session ${path} is not a folder that visual:review made. Run the command without --session to start a new session.`,
    )
  return real
}

/**
 * The agent judge. It writes a judgment request for one screenshot into
 * `<session>/<screenshot id>/`: `request.md` (the rules, the rubric, the
 * measured regions and the JSON Schema of the reply) and the images, prepared
 * to the side limits of the vision models. The coding agent reads them and
 * writes `verdict.json` in the same folder. The next call reads that file as
 * a model reply. A request that changed (other regions, other images, another
 * brief) removes the old `verdict.json`.
 *
 * `session` is a private folder that this command made (see `ownSession`),
 * outside the run folder and the checkout: PR code can write those, and a
 * verdict there would be the verdict of the PR author. The first call of a
 * session (`read` false) only writes the requests. `rerun` is the command for
 * the next call.
 */
async function judgeByAgent(
  {
    storyId,
    prompt,
    parse,
  }: {
    storyId: string
    prompt: Prompt
    /** Read the reply as a verdict: `parseVerdict` or `parseNewVerdict`. */
    parse: (reply: string, run: RunFacts) => Verdict
  },
  { session, rerun, read }: { session: string; rerun: string; read: boolean },
): Promise<Verdict> {
  // The screenshot id names the folder. Another character than a letter, a
  // digit, `_`, `-`, `.` or `@` becomes `_`, so the name stays one folder in
  // the session. A short hash of the id then keeps two ids apart.
  const safe = storyId.replace(/[^\w@.-]/g, "_")
  const folder = join(
    session,
    safe === storyId
      ? safe
      : `${safe}-${createHash("sha256").update(storyId).digest("hex").slice(0, 8)}`,
  )
  await mkdir(folder, { recursive: true })
  const images = await Promise.all(
    prompt.images.map(async ({ role, path }, index) => ({
      name: `${index + 1}-${role}.png`,
      png: prepareImage(await readFile(path)).png,
    })),
  )
  const hash = createHash("sha256")
  // The name and the length of each image go in first, so that bytes cannot
  // move from one image to the next with the same hash.
  for (const { name, png } of images)
    hash.update(`${name} ${png.length}\n`).update(png)
  const request = `# Visual judgment request: ${storyId}

You are the judge. Read the rules and the story below. Then read each image file in this folder, in the order of the list. Write your reply as \`verdict.json\` in this folder: one JSON object that matches the JSON Schema at the end of the rules. Then run this command again: \`${rerun}\`

Image files:
${images.map(({ name }) => `- ${name}`).join("\n")}

${prompt.prefix}

${prompt.story}

Input: sha256 ${hash.digest("hex")}
`
  const pending = (error: string): Verdict => ({
    storyId,
    observations: [],
    verdict: "unsure",
    severity: "none",
    confidence: 0,
    summary: "No agent verdict yet.",
    qualities: [],
    findings: [],
    model: "agent",
    costUsd: 0,
    latencyMs: 0,
    error,
  })

  const requestPath = join(folder, "request.md")
  const verdictPath = join(folder, "verdict.json")
  const written = await readFile(requestPath, "utf8").catch(() => undefined)
  if (!read || written !== request) {
    await rm(verdictPath, { force: true })
    for (const { name, png } of images) await writeFile(join(folder, name), png)
    await writeFile(requestPath, request)
    return pending(
      `Judge ${requestPath}, then write ${verdictPath}. Then run: ${rerun}`,
    )
  }
  const reply = await readFile(verdictPath, "utf8").catch(() => undefined)
  if (reply === undefined)
    return pending(
      `Judge ${requestPath}, then write ${verdictPath}. Then run: ${rerun}`,
    )
  // `parse` checks the reply against the reply schema of the prompt, as for a
  // model reply. A reply that does not match gives `unsure` with the cause in
  // `error`.
  return parse(reply, { model: "agent", costUsd: 0, latencyMs: 0 })
}

/** One block for each judged story, with the stories of its group. */
function report(verdicts: readonly Verdict[]): string {
  const lines: string[] = []
  for (const verdict of verdicts) {
    if (verdict.groupedWith) continue
    lines.push(
      `${blocks(verdict) ? "BLOCKS " : ""}${verdict.verdict} ${verdict.severity} ${verdict.storyId}: ${verdict.summary}`,
    )
    if (verdict.error) lines.push(`  error: ${verdict.error}`)
    for (const { kind, region, evidence, suggestion } of verdict.findings)
      lines.push(
        `  - ${kind} at x ${region.x.toFixed(2)}, y ${region.y.toFixed(2)}: ${evidence}${suggestion ? ` Fix: ${suggestion}` : ""}`,
      )
    const group = verdicts.filter(
      ({ groupedWith }) => groupedWith === verdict.storyId,
    )
    if (group[0])
      lines.push(
        `  group: ${group.length} more stories with the same diff, verdict ${group[0].verdict}: ${group.map(({ storyId }) => storyId).join(", ")}`,
      )
  }
  const blocking = verdicts.filter(blocks).length
  lines.push(
    verdicts.length
      ? `${verdicts.length} stories reviewed; ${blocking} ${blocking === 1 ? "verdict blocks" : "verdicts block"}.`
      : "No changed story to review.",
  )
  return lines.join("\n")
}

if (import.meta.main)
  process.exitCode = await visualReview(process.argv.slice(2), (text) =>
    process.stdout.write(`${text}\n`),
  )
