// The judge panel of the unseen calibration set (CTX-1289). The owner did
// not review these screenshots, so the panel labels them: each member says
// on its own if a screenshot (or a change) has a `defect` or is `fine`, with
// a reason. Only a unanimous label counts for the score of the calibration
// (calibration.ts). See README.md beside this file.
//
// Usage: node packages/visual-review/evals/critic/label-unseen.ts
//          [--models <list>] [--max-cost 15] [--images <dir>] [--unseen <path>]

import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { z } from "zod"

import { buildNewPanelPrompt, buildPanelPrompt } from "../../src/prompt.ts"
import {
  screenshotCase,
  unseenLabels,
  unseenSchema,
  type Unseen,
  type UnseenLabel,
} from "./calibration.ts"
import {
  defaultModels,
  otherPanel,
  panelOptions,
  replySchema,
  runPanel,
} from "./panel.ts"

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

/**
 * Run `node packages/visual-review/evals/critic/label-unseen.ts` with the
 * command-line arguments `args`. `print` gets the output. Returns the exit
 * code: 2 for a usage or input error, also a missing or changed image.
 */
export async function labelUnseen(
  args: readonly string[],
  print: (text: string) => void,
): Promise<number> {
  const options = panelOptions(args, usage, {
    maxCost: "15",
    file: {
      name: "unseen",
      path: join(import.meta.dirname, "unseen-calibration.json"),
    },
  })
  if (typeof options === "string") {
    print(options)
    return 2
  }
  const { models, maxCost } = options
  let unseen: Unseen
  try {
    unseen = unseenSchema.parse(
      JSON.parse(await readFile(options.file, "utf8")),
    )
  } catch (error) {
    print(`${(error as Error).message}\n\n${usage}`)
    return 2
  }
  const mismatch = otherPanel(unseen.panelModels, models)
  if (mismatch) {
    print(mismatch)
    return 2
  }

  // A screenshot with a failed vote (an outage, a reply that is not usable)
  // is judged again.
  const queue = unseen.screenshots.filter(
    ({ panel }) => !panel || panel.votes.some(({ error }) => error),
  )
  const { votes, stopped, imageError, spent } = await runPanel(
    queue,
    options,
    async (shot, prepareCase) => {
      const prepared = await prepareCase(screenshotCase(shot), shot.scope)
      if (prepared.kind === "change")
        // A change gets the change prompt of the panel: a regression is a
        // defect, an improvement or no change is fine.
        return {
          prompt: buildPanelPrompt(prepared.story, z.toJSONSchema(replySchema)),
          reply: replySchema,
          label: (given): UnseenLabel =>
            given === "regression" ? "defect" : "fine",
        }
      const reply = z.object({
        reason: z.string(),
        label: z.enum(unseenLabels),
      })
      return {
        prompt: buildNewPanelPrompt(prepared.newStory, z.toJSONSchema(reply)),
        reply,
        label: (given) => given as UnseenLabel,
      }
    },
  )

  const next = unseenSchema.parse({
    ...unseen,
    // A run that judged nothing does not tie the set to its models.
    ...(votes.size && { panelModels: models }),
    screenshots: unseen.screenshots.map((shot) => {
      const given = votes.get(shot.id)
      return given
        ? { ...shot, panel: { label: unanimous(given), votes: given } }
        : shot
    }),
  })
  await writeFile(options.file, `${JSON.stringify(next, null, 2)}\n`)

  const sources = [...new Set(next.screenshots.map(({ source }) => source))]
  const tally = (shots: Unseen["screenshots"]) => {
    const of = (label: UnseenLabel | null) =>
      shots.filter(({ panel }) => panel && panel.label === label).length
    return `${of("defect")} defect, ${of("fine")} fine, ${of(null)} without agreement, ${shots.filter(({ panel }) => !panel).length} not judged`
  }
  const lines = [
    `Judge panel: ${models.join(", ")}. Rule: a label counts when each member gives it.`,
    `${votes.size} screenshots judged, $${spent.toFixed(2)} of the $${maxCost} cap.${stopped ? " The spend cap stopped the panel: run it again to judge the other screenshots." : ""}`,
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
