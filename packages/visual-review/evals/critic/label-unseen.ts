// The judge panel of the unseen calibration set (CTX-1289). The owner did
// not review these screenshots, so the panel labels them: each member says
// on its own if a screenshot (or a change) has a `defect` or is `fine`, with
// a reason. Only a unanimous label counts for the score of the calibration
// (calibration.ts). See README.md beside this file.
//
// Usage: node packages/visual-review/evals/critic/label-unseen.ts
//          [--models <list>] [--max-cost 15] [--images <dir>] [--unseen <path>]

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { z } from "zod"

import { buildNewPanelPrompt, buildPanelPrompt } from "../../src/prompt.ts"
import {
  screenshotCase,
  unseenLabels,
  unseenSchema,
  type Unseen,
  type UnseenLabel,
} from "./calibration.ts"
import { imageStore, releaseUrl } from "./images.ts"
import { defaultModels, panelMember, replySchema, type Vote } from "./panel.ts"
import { prepare } from "./run.ts"
import { spendMeter } from "./spend.ts"

const usage = `Usage: node packages/visual-review/evals/critic/label-unseen.ts [--models <list>] [--max-cost 15] [--images <dir>] [--unseen <path>]

  --models    The panel, comma-separated OpenRouter ids, at least 3.
              Default: ${defaultModels.join(",")}
  --max-cost  The spend cap in USD. A call starts only while the spend is
              below it. Default: 15
  --images    The folder of the images. Default: .ci-results/visual-bakeoff/images
  --unseen    The unseen set. Default: unseen-calibration.json beside this file.

The panel judges each screenshot that has no panel votes yet, or a failed
vote, 4 screenshots at the same time. It writes the votes and the labels
into the file. The key and the endpoint come from MODEL_PROVIDER_API_KEY and
MODEL_PROVIDER_URL.`

/**
 * The agreement rule of the unseen set: a label counts only when each member
 * gives it. A failed vote or one other label leaves the screenshot without a
 * label, and it does not count for the score. On the 119 synthetic cases of
 * cases.json with known labels, the 3 members agreed on 104, and the
 * unanimous label was right on 100 (96%). The 2-of-3 majority was right on
 * 106 of 119 (89%). The unseen set selects a critic change, so a wrong label
 * costs more than a smaller set.
 */
export function unanimous(
  votes: readonly { label: UnseenLabel | null }[],
): UnseenLabel | null {
  const [first] = votes
  return first?.label && votes.every(({ label }) => label === first.label)
    ? first.label
    : null
}

/** The reply of a member on a screenshot with no earlier image. */
const newReplySchema = z.object({
  reason: z.string(),
  label: z.enum(unseenLabels),
})

/** The unseen label of a vote on a change: a regression is a defect. */
const fromChange = (vote: Vote<string>): Vote<UnseenLabel> => ({
  ...vote,
  label:
    vote.label === null
      ? null
      : vote.label === "regression"
        ? "defect"
        : "fine",
})

/**
 * Run `node packages/visual-review/evals/critic/label-unseen.ts` with the
 * command-line arguments `args`. `print` gets the output. Returns the exit
 * code: 2 for a usage or input error, also a missing or changed image.
 */
export async function labelUnseen(
  args: readonly string[],
  print: (text: string) => void,
): Promise<number> {
  let options
  let unseen: Unseen
  try {
    ;({ values: options } = parseArgs({
      args: [...args],
      strict: true,
      options: {
        models: { type: "string", default: defaultModels.join(",") },
        "max-cost": { type: "string", default: "15" },
        images: {
          type: "string",
          default: ".ci-results/visual-bakeoff/images",
        },
        unseen: {
          type: "string",
          default: join(import.meta.dirname, "unseen-calibration.json"),
        },
      },
    }))
    unseen = unseenSchema.parse(
      JSON.parse(await readFile(options.unseen, "utf8")),
    )
  } catch (error) {
    print(`${(error as Error).message}\n\n${usage}`)
    return 2
  }
  const models = options.models
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean)
  const maxCost = Number(options["max-cost"])
  if (
    models.length < 3 ||
    new Set(models).size !== models.length ||
    !(maxCost >= 0)
  ) {
    print(
      `--models needs 3 or more different models, and --max-cost a number of 0 or more.\n\n${usage}`,
    )
    return 2
  }
  if (!process.env.MODEL_PROVIDER_API_KEY) {
    print("Set MODEL_PROVIDER_API_KEY (the OpenRouter key) for the panel.")
    return 2
  }
  // The votes of one set come from one panel.
  if (unseen.panelModels && unseen.panelModels.join(",") !== models.join(",")) {
    print(
      `The set has the votes of the panel ${unseen.panelModels.join(", ")}. Use the same --models, or remove the panel votes first.`,
    )
    return 2
  }

  const spend = spendMeter(maxCost)
  const change = panelMember(replySchema, spend)
  const fresh = panelMember(newReplySchema, spend)
  let stopped = false
  let imageError: string | undefined
  const panels = new Map<
    string,
    NonNullable<Unseen["screenshots"][number]["panel"]>
  >()
  const images = resolve(options.images)
  const get = imageStore(images, releaseUrl)
  const work = await mkdtemp(join(tmpdir(), "visual-unseen-"))
  // A screenshot with a failed vote (an outage, a reply that is not usable)
  // is judged again.
  const queue = unseen.screenshots.filter(
    ({ panel }) => !panel || panel.votes.some(({ error }) => error),
  )
  try {
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let shot = queue.shift(); shot; shot = queue.shift()) {
          if (stopped || imageError) return
          let ask: (model: string) => Promise<Vote<UnseenLabel> | undefined>
          try {
            const prepared = await prepare(
              screenshotCase(shot),
              shot.scope,
              get,
              images,
              work,
            )
            if (prepared.kind === "change") {
              const prompt = buildPanelPrompt(prepared.story, change.schema)
              ask = async (model) => {
                const given = await change.ask(prompt, model)
                return given && fromChange(given)
              }
            } else {
              const prompt = buildNewPanelPrompt(
                prepared.newStory,
                fresh.schema,
              )
              ask = (model) => fresh.ask(prompt, model)
            }
          } catch (error) {
            imageError ??= (error as Error).message
            return
          }
          const votes = await Promise.all(models.map((model) => ask(model)))
          // A screenshot that the cap stopped gets no panel: the next run
          // judges it again.
          if (votes.some((given) => given === undefined)) {
            stopped = true
            return
          }
          const given = votes.filter((one) => one !== undefined)
          panels.set(shot.id, { label: unanimous(given), votes: given })
        }
      }),
    )
  } finally {
    await rm(work, { recursive: true, force: true })
  }

  const next = unseenSchema.parse({
    ...unseen,
    panelModels: models,
    screenshots: unseen.screenshots.map((shot) => {
      const panel = panels.get(shot.id)
      return panel ? { ...shot, panel } : shot
    }),
  })
  await writeFile(options.unseen, `${JSON.stringify(next, null, 2)}\n`)

  const { spent } = spend.totals()
  const sources = [...new Set(next.screenshots.map(({ source }) => source))]
  const tally = (shots: Unseen["screenshots"]) => {
    const of = (label: UnseenLabel | null) =>
      shots.filter(({ panel }) => panel && panel.label === label).length
    return `${of("defect")} defect, ${of("fine")} fine, ${of(null)} without agreement, ${shots.filter(({ panel }) => !panel).length} not judged`
  }
  const lines = [
    `Judge panel: ${models.join(", ")}. Rule: a label counts when each member gives it.`,
    `${panels.size} screenshots judged, $${spent.toFixed(2)} of the $${maxCost} cap.${stopped ? " The spend cap stopped the panel: run it again to judge the other screenshots." : ""}`,
    `All: ${tally(next.screenshots)}.`,
    ...sources.map(
      (source) =>
        `- ${source}: ${tally(next.screenshots.filter((shot) => shot.source === source))}.`,
    ),
    ...models.map(
      (model) =>
        `- ${model}: ${next.screenshots.filter(({ panel }) => panel?.votes.find((one) => one.model === model)?.error).length} errors.`,
    ),
  ]
  if (imageError) lines.push(imageError)
  print(lines.join("\n"))
  return imageError ? 2 : 0
}

if (import.meta.main)
  process.exitCode = await labelUnseen(process.argv.slice(2), (text) =>
    process.stdout.write(`${text}\n`),
  )
