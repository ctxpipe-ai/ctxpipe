// `pnpm visual:review`: the visual critic for one visual run. It reads the
// manifest of the run, reviews each changed story (see `reviewStories`), and
// prints one verdict for each story or group. A fork can run it with no
// factory: `--judge model` uses the key of the contributor, and `--judge
// agent` lets the coding agent of the contributor judge, at no cost.
import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { parseArgs } from "node:util"

import { judgeWithJev } from "./adapters/jev.ts"
import { judgeWithOpenRouter } from "./adapters/openrouter.ts"
import { manifestSchema, realInside, toStoryInput } from "./compare/manifest.ts"
import { prepareImage } from "./prepare.ts"
import { buildPrompt } from "./prompt.ts"
import { reviewStories } from "./review.ts"
import type { StoryInput } from "./story.ts"
import { parseVerdict, type Verdict } from "./verdict.ts"

const defaultModel = "anthropic/claude-sonnet-5.5"

const usage = `Usage: pnpm visual:review [--manifest <path>] [--judge model|agent] [--model <id>] [--filter jev|none] [--brief <file>] [--json]

  --manifest  The manifest of the visual run. Default: .ci-results/visual/manifest.json
  --judge     model: a vision model through OpenRouter, with MODEL_PROVIDER_API_KEY
              (and MODEL_PROVIDER_URL). agent: write a judgment request for each
              story; your coding agent writes its verdict.json; run again to read it.
              Default: model.
  --model     The explainer model of --judge model. Default: ${defaultModel}
  --filter    jev: ask the Jev filter first, and call the explainer only when Jev
              does not accept the change. Only with --judge model. Default: none.
  --brief     A file with the ticket or the brief of the change. Without it, no
              verdict can be intended.
  --json      Print the verdicts as one JSON array.

Exit code: 2 when the review is not complete (a usage or manifest error, a
verdict with an error, or an agent judgment that is not written yet); else 1
when a verdict is regression with severity major or blocker; else 0.

The agent judge keeps its requests and verdicts in
.ci-results/visual-review/<run>/ below the current folder, never in the run
folder: a run folder can come from an artifact that PR code wrote.`

/**
 * Run `visual:review` with the command-line arguments `args`. `print` gets
 * the output. `cwd` holds the folder of the agent judge. The key and the
 * endpoint of the model come from `process.env`. Returns the exit code.
 */
export async function visualReview(
  args: readonly string[],
  { print, cwd }: { print: (text: string) => void; cwd: string },
): Promise<number> {
  let options
  try {
    options = parseArgs({
      args: [...args],
      strict: true,
      options: {
        manifest: {
          type: "string",
          default: ".ci-results/visual/manifest.json",
        },
        judge: { type: "string", default: "model" },
        model: { type: "string", default: defaultModel },
        filter: { type: "string", default: "none" },
        brief: { type: "string" },
        json: { type: "boolean", default: false },
      },
    }).values
  } catch (error) {
    print(`${(error as Error).message}\n\n${usage}`)
    return 2
  }
  const { judge, filter, model } = options
  if (
    (judge !== "model" && judge !== "agent") ||
    (filter !== "jev" && filter !== "none") ||
    (judge === "agent" && filter === "jev")
  ) {
    print(
      `--judge must be model or agent, and --filter must be jev or none (jev only with --judge model).\n\n${usage}`,
    )
    return 2
  }

  let stories: StoryInput[]
  let root: string
  let judgments: string
  try {
    const path = resolve(cwd, options.manifest)
    root = dirname(path)
    // The manifest can come from an artifact that PR code wrote. A link
    // there could make this command read, and print, a file outside the run.
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("The manifest is a symbolic link. Give the real file.")
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    )
    const brief =
      options.brief === undefined
        ? undefined
        : await readFile(resolve(cwd, options.brief), "utf8")
    // The critic judges only a change beyond the tolerance. A new, removed,
    // unstable or failed story is the job of the visual check.
    const reviewed = manifest.stories.filter(
      ({ status }) => status === "changed" || status === "size-changed",
    )
    const realRoot = await realpath(root)
    judgments = join(
      await realpath(cwd),
      ".ci-results",
      "visual-review",
      createHash("sha256").update(realRoot).digest("hex").slice(0, 12),
    )
    if (relative(realRoot, judgments).split(sep)[0] !== "..")
      throw new Error(
        `The judgment folder ${judgments} is inside the run folder. Run the command from a folder outside the run folder.`,
      )
    stories = []
    for (const story of reviewed) {
      if (!story.images.before || !story.images.after)
        throw new Error(
          `Story ${story.id} is ${story.status}, but it has no before and after image.`,
        )
      const input = toStoryInput(manifest, story, {
        root,
        ...(brief === undefined ? {} : { brief }),
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
    print(
      `Cannot read the manifest ${options.manifest}: ${(error as Error).message}`,
    )
    return 2
  }

  let verdicts: Verdict[]
  try {
    verdicts = await reviewStories(
      stories,
      judge === "agent"
        ? (story) => judgeByAgent(story, judgments)
        : async (story) => {
            const filtered =
              filter === "jev" ? await judgeWithJev(story) : undefined
            // Jev says intended only when nothing got worse and a brief or a
            // source diff explains the change: then no explainer is needed.
            if (filtered?.verdict === "intended" && !filtered.error)
              return filtered
            const explained = await judgeWithOpenRouter(
              story,
              model,
              process.env,
            )
            if (!filtered) return explained
            return {
              ...explained,
              costUsd:
                explained.costUsd === null || filtered.costUsd === null
                  ? null
                  : explained.costUsd + filtered.costUsd,
              latencyMs: explained.latencyMs + filtered.latencyMs,
            }
          },
    )
  } catch (error) {
    print(`The review stopped: ${(error as Error).message}`)
    return 2
  }

  print(options.json ? JSON.stringify(verdicts, null, 2) : report(verdicts))
  if (verdicts.some(({ error }) => error !== undefined)) return 2
  if (verdicts.some(blocks)) return 1
  return 0
}

/** The blocking rule of the product owner. */
const blocks = ({ verdict, severity }: Verdict) =>
  verdict === "regression" && (severity === "major" || severity === "blocker")

/**
 * The agent judge. It writes a judgment request for `story` into
 * `<judgments>/<screenshot id>/`: `request.md` (the rules, the rubric, the
 * measured regions and the JSON Schema of the reply) and the images, prepared
 * to the side limits of the vision models. The coding agent reads them and
 * writes `verdict.json` in the same folder. The next call reads that file as
 * a model reply. A request that changed (other regions, other images, another
 * brief) removes the old `verdict.json`.
 *
 * `judgments` is a folder of the reviewer, outside the run folder. The run
 * folder can come from an artifact that PR code wrote, so a verdict there
 * would be the verdict of the PR author.
 */
async function judgeByAgent(
  story: StoryInput,
  judgments: string,
): Promise<Verdict> {
  // The screenshot id is a folder name here, so it may not climb out of the
  // folder.
  if (!/^[\w-]+(@[\w-]+)?\.(desktop|mobile)$/.test(story.storyId))
    throw new Error(
      `Screenshot id "${story.storyId}" is not a valid folder name.`,
    )
  const folder = join(judgments, story.storyId)
  await mkdir(folder, { recursive: true })
  const prompt = buildPrompt(story)
  const images = await Promise.all(
    prompt.images.map(async ({ role, path }, index) => ({
      name: `${index + 1}-${role}.png`,
      png: prepareImage(await readFile(path)).png,
    })),
  )
  const hash = createHash("sha256")
  for (const { png } of images) hash.update(png)
  const request = `# Visual judgment request: ${story.storyId}

You are the judge. Read the rules and the story below. Then read each image file in this folder, in the order of the list. Write your reply as \`verdict.json\` in this folder: one JSON object that matches the JSON Schema at the end of the rules. Then run \`pnpm visual:review --judge agent\` again.

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
  if (written !== request) {
    for (const name of await readdir(folder))
      await rm(join(folder, name), { recursive: true, force: true })
    for (const { name, png } of images) await writeFile(join(folder, name), png)
    await writeFile(requestPath, request)
    return pending(`Judge ${requestPath}, then write ${verdictPath}.`)
  }
  const reply = await readFile(verdictPath, "utf8").catch(() => undefined)
  if (reply === undefined)
    return pending(`Judge ${requestPath}, then write ${verdictPath}.`)
  // `parseVerdict` checks the reply against the judgement part of
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
  process.exitCode = await visualReview(process.argv.slice(2), {
    print: (text) => process.stdout.write(`${text}\n`),
    cwd: process.cwd(),
  })
