// `pnpm visual:review`: the visual critic for one visual run. It reads the
// manifest of the run, reviews each changed story (see `reviewStories`), and
// prints one verdict for each story or group. With `--images`, it reads the
// base and head images of the factory review folder instead, and prints one
// verdict for each path (the visual critic of `critics.json`). A fork can run it with no
// factory: `--judge model` uses the key of the contributor, and `--judge
// agent` lets the coding agent of the contributor judge, at no cost.
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

import { judgeWithJev } from "./adapters/jev.ts"
import { judgeWithOpenRouter } from "./adapters/openrouter.ts"
import { diff } from "./compare/diff.ts"
import { writeStoryImages } from "./compare/images.ts"
import {
  insideRoot,
  manifestSchema,
  realInside,
  storyInput,
  toStoryInput,
} from "./compare/manifest.ts"
import { prepareImage } from "./prepare.ts"
import { buildPrompt } from "./prompt.ts"
import { reviewStories } from "./review.ts"
import { storiesOf } from "./story-tags.ts"
import type { StoryInput } from "./story.ts"
import { parseVerdict, type Verdict } from "./verdict.ts"

const defaultModel = "anthropic/claude-sonnet-5.5"

const usage = `Usage: pnpm visual:review [--manifest <path>] [--judge model|agent] [--model <id>] [--filter jev|none] [--brief <file>] [--session <folder>] [--json]
       pnpm visual:review --images <folder> [--model <id>] [--filter jev|none] [--brief <file>] [--json] -- <path>...

  --manifest  The manifest of the visual run. Default: .ci-results/visual/manifest.json
  --images    A folder with base/<path> and head/<path> for each screenshot
              path after --, as the factory writes it. The command compares
              each pair with its own compare engine and gives one verdict for
              each path, with "path". A new or a removed screenshot is unsure.
              Only with --judge model. Without MODEL_PROVIDER_API_KEY, the
              exit code is 2, also when no screenshot needs a model.
  --judge     model: a vision model through OpenRouter, with MODEL_PROVIDER_API_KEY
              (and MODEL_PROVIDER_URL). agent: write a judgment request for each
              story; your coding agent writes its verdict.json; run again to read it.
              Default: model.
  --model     The explainer model of --judge model. Default: ${defaultModel}
  --filter    jev: ask the Jev filter first, and call the explainer only when Jev
              does not accept the change. Only with --judge model. Default: none.
  --brief     A file with the ticket or the brief of the change. Without it, no
              verdict can be intended.
  --session   Only with --judge agent: the folder that the first call made and
              printed. Without it, the call makes a new folder and reads no
              verdict.
  --json      Print the verdicts as one JSON array.

Exit code: 2 when the review is not complete (a usage, manifest or image
error, a verdict with an error, or an agent judgment that is not written yet); else 1
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
        json: { type: "boolean", default: false },
      },
    }))
  } catch (error) {
    print(`${(error as Error).message}\n\n${usage}`)
    return 2
  }
  const { judge, filter, model } = options
  if (
    (judge !== "model" && judge !== "agent") ||
    (filter !== "jev" && filter !== "none") ||
    (judge === "agent" && filter === "jev") ||
    (judge === "model" && options.session !== undefined) ||
    (options.images !== undefined) !== paths.length > 0 ||
    (options.images !== undefined &&
      (options.manifest !== undefined || judge !== "model"))
  ) {
    print(
      `--judge must be model or agent, and --filter must be jev or none (jev only with --judge model, --session only with --judge agent). --images needs the paths after --, and only goes with --judge model and no --manifest.\n\n${usage}`,
    )
    return 2
  }

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
      try {
        const brief =
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
        judged = await reviewStories(
          screenshots.flatMap(({ story }) => (story ? [story] : [])),
          (story) => judgeByModel(story, model, filter),
        )
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
      return finish(verdicts, options.json, print)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  let stories: StoryInput[]
  const path = resolve(options.manifest ?? ".ci-results/visual/manifest.json")
  const root = dirname(path)
  let brief: string | undefined
  try {
    // The manifest can come from an artifact that PR code wrote. A link
    // there could make this command read, and print, a file outside the run.
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("The manifest is a symbolic link. Give the real file.")
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    )
    brief = options.brief === undefined ? undefined : resolve(options.brief)
    const briefText =
      brief === undefined ? undefined : await readFile(brief, "utf8")
    // The critic judges only a change beyond the tolerance. A new, removed,
    // unstable or failed story is the job of the visual check.
    const reviewed = manifest.stories.filter(
      ({ status }) => status === "changed" || status === "size-changed",
    )
    const realRoot = await realpath(root)
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
    verdicts = await reviewStories(
      stories,
      agent
        ? (story) => judgeByAgent(story, agent)
        : (story) => judgeByModel(story, model, filter),
    )
  } catch (error) {
    print(`The review stopped: ${(error as Error).message}`)
    return 2
  }
  return finish(verdicts, options.json, print)
}

/** Print the verdicts, and return the exit code. */
function finish(
  verdicts: readonly Verdict[],
  json: boolean,
  print: (text: string) => void,
): number {
  print(json ? JSON.stringify(verdicts, null, 2) : report(verdicts))
  if (verdicts.some(({ error }) => error !== undefined)) return 2
  if (verdicts.some(blocks)) return 1
  return 0
}

/**
 * The model judge: the explainer `model`, after the Jev filter if asked (the
 * cascade). The bake-off runs the same cascade, also with another decision
 * model (`filterModel`) as the filter.
 */
export async function judgeByModel(
  story: StoryInput,
  model: string,
  filter: "jev" | "none",
  filterModel?: string,
): Promise<Verdict> {
  const filtered =
    filter === "jev" ? await judgeWithJev(story, filterModel) : undefined
  // Jev says intended only when nothing got worse and a brief or a source
  // diff explains the change: then no explainer is needed.
  if (filtered?.verdict === "intended" && !filtered.error) return filtered
  const explained = await judgeWithOpenRouter(story, model, process.env)
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
 * One screenshot of `--images`: the story for the judge, or a verdict that
 * needs no judge.
 */
type Screenshot = {
  path: string
  story?: StoryInput
  verdict?: Verdict
  /** Added to the summary of the verdict. */
  note?: string
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
 * - A path with no base image is a new screenshot, and a path with no head
 *   image a removed one. Each is `unsure`: a person looks at it.
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
      if (!before && !after)
        throw new Error(`${folder} has no base and no head image of it.`)
      if (!before) {
        screenshots.push(
          plain(
            "unsure",
            "A new screenshot: there is no base image to compare. A person looks at it.",
          ),
        )
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
 * The agent judge. It writes a judgment request for `story` into
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
  story: StoryInput,
  { session, rerun, read }: { session: string; rerun: string; read: boolean },
): Promise<Verdict> {
  // The screenshot id names the folder. Another character than a letter, a
  // digit, `_`, `-`, `.` or `@` becomes `_`, so the name stays one folder in
  // the session. A short hash of the id then keeps two ids apart.
  const safe = story.storyId.replace(/[^\w@.-]/g, "_")
  const folder = join(
    session,
    safe === story.storyId
      ? safe
      : `${safe}-${createHash("sha256").update(story.storyId).digest("hex").slice(0, 8)}`,
  )
  await mkdir(folder, { recursive: true })
  const prompt = buildPrompt(story)
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
  const request = `# Visual judgment request: ${story.storyId}

You are the judge. Read the rules and the story below. Then read each image file in this folder, in the order of the list. Write your reply as \`verdict.json\` in this folder: one JSON object that matches the JSON Schema at the end of the rules. Then run this command again: \`${rerun}\`

Image files:
${images.map(({ name }) => `- ${name}`).join("\n")}

${prompt.prefix}

${prompt.story}

Input: sha256 ${hash.digest("hex")}
`
  const pending = (error: string): Verdict => ({
    storyId: story.storyId,
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
  // `parseVerdict` checks the reply against the judgment part of
  // `verdictSchema`, as for a model reply. A reply that does not match gives
  // `unsure` with the cause in `error`.
  return parseVerdict(reply, story, {
    model: "agent",
    costUsd: 0,
    latencyMs: 0,
  })
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
