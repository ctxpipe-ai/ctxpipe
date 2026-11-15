// The judge panel of the bake-off (CTX-1249). Strong models of different
// families each label each change case on their own: `improvement`,
// `regression` or `no-change`, with a reason. The agreement rule makes one
// label of the votes. The panel label of a real change is the label that the
// bake-off scores the arms against. A real change without agreement goes to
// the owner queue (queue.ts). A synthetic case keeps its known label: the
// panel result on it measures the panel. See README.md beside this file.
//
// Usage: node packages/visual-review/evals/critic/panel.ts [--models <list>]
//          [--max-cost 40] [--images <dir>] [--cases <path>]

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { z } from "zod"

import { askOpenRouter } from "../../src/adapters/openrouter.ts"
import { buildPanelPrompt, type Prompt } from "../../src/prompt.ts"
import type { StoryInput } from "../../src/story.ts"
import { parseJsonReply } from "../../src/verdict.ts"
import {
  caseManifestSchema,
  panelLabels,
  readManifest,
  type Case,
  type Panel,
  type PanelLabel,
} from "./cases.ts"
import { imageStore, releaseUrl } from "./images.ts"
import { prepare } from "./run.ts"
import { spendMeter } from "./spend.ts"

/** The default panel: one strong vision model of each of three families. */
export const defaultModels = [
  "anthropic/claude-opus-5.5",
  "openai/gpt-6.1-sol",
  "google/gemini-4-argon",
]

const usage = `Usage: node packages/visual-review/evals/critic/panel.ts [--models <list>] [--max-cost 40] [--images <dir>] [--cases <path>]

  --models       The panel, comma-separated OpenRouter ids, at least 3.
                 Default: ${defaultModels.join(",")}
  --max-cost     The spend cap in USD. A call starts only while the spend is
                 below it. Default: 40
  --images       The folder of the case images. Default:
                 .ci-results/visual-bakeoff/images
  --cases        The case manifest. Default: cases.json beside this file.

The panel judges each case that has a before image and no panel votes yet,
or a failed vote, 4 cases at the same time. It writes the votes and the
labels into the manifest. The key and the endpoint come from
MODEL_PROVIDER_API_KEY and MODEL_PROVIDER_URL.`

/** The reply of one member: the reason first, then the label. */
export const replySchema = z.object({
  reason: z.string(),
  label: z.enum(panelLabels),
})

/**
 * The agreement rule: a plain majority. A label counts when more than half of
 * the members give it (2 of 3). A member whose call failed gives no vote, but
 * it stays in the count of the members. Null when there is no majority: the
 * owner labels the case.
 */
export function agreement(
  votes: readonly { label: PanelLabel | null }[],
): PanelLabel | null {
  return (
    panelLabels.find(
      (label) =>
        2 * votes.filter((vote) => vote.label === label).length > votes.length,
    ) ?? null
  )
}

/** The panel label that a synthetic case must get. */
const known = (entry: Case): PanelLabel | undefined =>
  entry.kind === "regression" || entry.kind === "mixed"
    ? "regression"
    : entry.kind === "noise"
      ? "no-change"
      : undefined

/** The vote of one member: a label, or no label and the error. */
export type Vote<Label extends string> = {
  model: string
  label: Label | null
  reason: string
  error?: string
}

/** The vote of a member that gave no usable answer. */
const noVote = (model: string, error: string) => ({
  model,
  label: null,
  reason: "",
  error,
})

/**
 * One question to the panel: the prompt, the schema of a reply, and the
 * label that a reply label gives.
 */
type Ballot<Label extends string> = {
  prompt: Prompt
  reply: z.ZodType<{ reason: string; label: string }>
  label: (given: string) => Label
}

/** The options of a panel command. `file` is the file of the votes. */
type PanelOptions = {
  models: string[]
  maxCost: number
  images: string
  file: string
}

/**
 * Parse the options of a panel command: `--models`, `--max-cost`, `--images`
 * and the option `file.name` of the file of the votes. Gives the options, or
 * the error text (also for a missing key).
 */
export function panelOptions(
  args: readonly string[],
  usage: string,
  defaults: { maxCost: string; file: { name: string; path: string } },
): PanelOptions | string {
  let values
  try {
    ;({ values } = parseArgs({
      args: [...args],
      strict: true,
      options: {
        models: { type: "string", default: defaultModels.join(",") },
        "max-cost": { type: "string", default: defaults.maxCost },
        images: {
          type: "string",
          default: ".ci-results/visual-bakeoff/images",
        },
        [defaults.file.name]: { type: "string", default: defaults.file.path },
      },
    }))
  } catch (error) {
    return `${(error as Error).message}\n\n${usage}`
  }
  const models = String(values.models)
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean)
  const maxCost = Number(values["max-cost"])
  if (
    models.length < 3 ||
    new Set(models).size !== models.length ||
    !(maxCost >= 0)
  )
    return `--models needs 3 or more different models, and --max-cost a number of 0 or more.\n\n${usage}`
  if (!process.env.MODEL_PROVIDER_API_KEY)
    return "Set MODEL_PROVIDER_API_KEY (the OpenRouter key) for the panel."
  return {
    models,
    maxCost,
    images: resolve(String(values.images)),
    file: resolve(String(values[defaults.file.name])),
  }
}

/** The votes of one file come from one panel: the error text, or undefined. */
export const otherPanel = (
  panelModels: readonly string[] | undefined,
  models: readonly string[],
) =>
  panelModels && panelModels.join(",") !== models.join(",")
    ? `The file has the votes of the panel ${panelModels.join(", ")}. Use the same --models, or remove the panel votes first.`
    : undefined

/**
 * Ask each member about each item, 4 items at the same time. `ballot` gives
 * the question of an item, or undefined when the panel does not judge it;
 * it prepares the images of a case with `prepareCase`. A call starts only
 * while the spend is below the cap. A failed call gets one retry; then the
 * member gives no vote. An item that the cap stopped gets no votes: the next
 * run judges it again. A missing or changed image stops the run with
 * `imageError`. The judge panel of the cases and the panel of the unseen
 * calibration set (label-unseen.ts) use it.
 */
export async function runPanel<
  Item extends { id: string },
  Label extends string,
>(
  items: readonly Item[],
  { models, maxCost, images }: PanelOptions,
  ballot: (
    item: Item,
    prepareCase: (
      entry: Case,
      scope: StoryInput["scope"],
    ) => ReturnType<typeof prepare>,
  ) => Promise<Ballot<Label> | undefined>,
) {
  const spend = spendMeter(maxCost)
  let stopped = false
  let imageError: string | undefined
  const votes = new Map<string, Vote<Label>[]>()
  const get = imageStore(images, releaseUrl)
  const work = await mkdtemp(join(tmpdir(), "visual-panel-"))
  const ask = async (
    { prompt, reply, label }: Ballot<Label>,
    model: string,
  ): Promise<Vote<Label> | undefined> => {
    for (let attempt = 1; ; attempt++) {
      if (!spend.open()) return undefined
      try {
        const { content, run } = await askOpenRouter(
          prompt,
          z.toJSONSchema(reply),
          model,
          process.env,
        )
        spend.count(run.costUsd)
        const parsed = parseJsonReply(content, reply)
        return "error" in parsed
          ? noVote(model, parsed.error)
          : {
              model,
              reason: parsed.data.reason,
              label: label(parsed.data.label),
            }
      } catch (error) {
        spend.count(null)
        if (attempt === 2) return noVote(model, (error as Error).message)
        await new Promise((done) => setTimeout(done, 5_000))
      }
    }
  }
  const queue = [...items]
  try {
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          if (stopped || imageError) return
          let question: Ballot<Label> | undefined
          try {
            question = await ballot(item, (entry, scope) =>
              prepare(entry, scope, get, images, work),
            )
          } catch (error) {
            imageError ??= (error as Error).message
            return
          }
          if (!question) continue
          const asked = question
          const given = await Promise.all(
            models.map((model) => ask(asked, model)),
          )
          if (given.some((one) => one === undefined)) {
            stopped = true
            return
          }
          votes.set(
            item.id,
            given.filter((one) => one !== undefined),
          )
        }
      }),
    )
  } finally {
    await rm(work, { recursive: true, force: true })
  }
  return { votes, stopped, imageError, spent: spend.totals().spent }
}

/**
 * Run `node packages/visual-review/evals/critic/panel.ts` with the command-line arguments `args`.
 * `print` gets the output. Returns the exit code: 2 for a usage or input
 * error, also a missing or changed image.
 */
export async function judgePanel(
  args: readonly string[],
  print: (text: string) => void,
): Promise<number> {
  const options = panelOptions(args, usage, {
    maxCost: "40",
    file: { name: "cases", path: join(import.meta.dirname, "cases.json") },
  })
  if (typeof options === "string") {
    print(options)
    return 2
  }
  const { models, maxCost } = options
  const manifest = await readManifest(options.file)
  const mismatch = otherPanel(manifest.panelModels, models)
  if (mismatch) {
    print(mismatch)
    return 2
  }

  // A new case has no before image, so the panel does not judge it: its
  // label stays the one of the builder. A case with a failed vote (an outage,
  // a reply that is not usable) is judged again, so that a short outage does
  // not fill the owner queue. A real change that the owner labeled after the
  // panel did not agree keeps that label: the panel does not judge it again.
  const queue = manifest.cases.filter(
    (entry) =>
      entry.kind !== "new" &&
      (!entry.panel ||
        (entry.panel.votes.some(({ error }) => error) &&
          !(
            entry.kind === "intended" &&
            entry.panel.label === null &&
            entry.label !== "unsure"
          ))),
  )
  const { votes, stopped, imageError, spent } = await runPanel(
    queue,
    options,
    async (entry, prepareCase) => {
      const prepared = await prepareCase(entry, manifest.scope)
      if (prepared.kind !== "change") return undefined
      return {
        // The Storybook story id names the page: context for the judge.
        prompt: buildPanelPrompt(
          { ...prepared.story, storyId: entry.storyId },
          z.toJSONSchema(replySchema),
        ),
        reply: replySchema,
        label: (given) => given as PanelLabel,
      }
    },
  )
  const panels = new Map<string, Panel>(
    [...votes].map(([id, given]) => [
      id,
      { label: agreement(given), votes: given },
    ]),
  )

  const cases = manifest.cases.map((entry) => {
    const panel = panels.get(entry.id)
    if (!panel) return entry
    return entry.kind === "intended"
      ? {
          ...entry,
          panel,
          label: panel.label
            ? (
                {
                  improvement: "intended",
                  regression: "regression",
                  "no-change": "noise",
                } as const
              )[panel.label]
            : ("unsure" as const),
        }
      : { ...entry, panel }
  })
  const next = caseManifestSchema.parse({
    ...manifest,
    panelModels: models,
    cases,
  })
  await writeFile(options.file, `${JSON.stringify(next, null, 2)}\n`)

  const judged = next.cases.filter(({ id }) => panels.has(id))
  const real = judged.filter(({ kind }) => kind === "intended")
  const owner = real.filter(({ panel }) => panel?.label === null)
  const tally = (labels: readonly (PanelLabel | null)[]) =>
    panelLabels
      .map(
        (label) => `${labels.filter((one) => one === label).length} ${label}`,
      )
      .join(", ")
  const synthetic = judged.filter((entry) => known(entry))
  const right = (label: PanelLabel | null | undefined, entry: Case) =>
    label === known(entry)
  const lines = [
    `Judge panel: ${models.join(", ")}. Rule: a label counts when more than half of the members give it.`,
    `${judged.length} cases judged, $${spent.toFixed(2)} of the $${maxCost} cap.${stopped ? " The spend cap stopped the panel: run it again to judge the other cases." : ""}`,
    `Real changes: ${real.length - owner.length} labeled (${tally(real.map(({ panel }) => panel?.label ?? null).filter(Boolean))}), ${owner.length} without agreement, for the owner queue${owner.length ? `: ${owner.map(({ id }) => id).join(", ")}` : ""}.`,
    `Known labels: the panel label is right on ${synthetic.filter((entry) => right(entry.panel?.label, entry)).length} of ${synthetic.length} synthetic cases.`,
    ...models.map(
      (model) =>
        `- ${model}: ${synthetic.filter((entry) => right(entry.panel?.votes.find((one) => one.model === model)?.label, entry)).length} of ${synthetic.length} votes right; ${judged.filter((entry) => entry.panel?.votes.find((one) => one.model === model)?.error).length} errors.`,
    ),
  ]
  if (imageError) lines.push(imageError)
  print(lines.join("\n"))
  return imageError ? 2 : 0
}

if (import.meta.main)
  process.exitCode = await judgePanel(process.argv.slice(2), (text) =>
    process.stdout.write(`${text}\n`),
  )
