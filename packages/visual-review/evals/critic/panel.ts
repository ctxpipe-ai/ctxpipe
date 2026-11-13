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
import { buildPanelPrompt } from "../../src/prompt.ts"
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
const defaultModels = [
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
const replySchema = z.object({
  reason: z.string(),
  label: z.enum(panelLabels),
})
const replyJsonSchema = z.toJSONSchema(replySchema)

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

/** The vote of a member that gave no usable answer. */
const noVote = (model: string, error: string): Panel["votes"][number] => ({
  model,
  label: null,
  reason: "",
  error,
})

/** The vote of one member, or a vote with no label and the error. */
async function vote(
  story: StoryInput,
  model: string,
): Promise<{ vote: Panel["votes"][number]; cost: number | null }> {
  const { content, run } = await askOpenRouter(
    buildPanelPrompt(story, replyJsonSchema),
    replyJsonSchema,
    model,
    process.env,
  )
  const reply = parseJsonReply(content, replySchema)
  return {
    vote:
      "error" in reply ? noVote(model, reply.error) : { model, ...reply.data },
    cost: run.costUsd,
  }
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
  let options
  try {
    ;({ values: options } = parseArgs({
      args: [...args],
      strict: true,
      options: {
        models: { type: "string", default: defaultModels.join(",") },
        "max-cost": { type: "string", default: "40" },
        images: {
          type: "string",
          default: ".ci-results/visual-bakeoff/images",
        },
        cases: { type: "string" },
      },
    }))
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
  const casesPath = resolve(
    options.cases ?? join(import.meta.dirname, "cases.json"),
  )
  const manifest = await readManifest(casesPath)
  // The votes of one manifest come from one panel.
  if (
    manifest.panelModels &&
    manifest.panelModels.join(",") !== models.join(",")
  ) {
    print(
      `The manifest has the votes of the panel ${manifest.panelModels.join(", ")}. Use the same --models, or remove the panel votes first.`,
    )
    return 2
  }

  const spend = spendMeter(maxCost)
  let stopped = false
  let imageError: string | undefined
  const panels = new Map<string, Panel>()
  const images = resolve(options.images)
  const get = imageStore(images, releaseUrl)
  const work = await mkdtemp(join(tmpdir(), "visual-panel-"))
  // A call starts only while the spend is below the cap. A failed call gets
  // one retry; then the member gives no vote.
  const ask = async (story: StoryInput, model: string) => {
    for (let attempt = 1; ; attempt++) {
      if (!spend.open()) {
        stopped = true
        return undefined
      }
      try {
        const { vote: given, cost } = await vote(story, model)
        spend.count(cost)
        return given
      } catch (error) {
        spend.count(null)
        if (attempt === 2) return noVote(model, (error as Error).message)
        await new Promise((done) => setTimeout(done, 5_000))
      }
    }
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
  try {
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let entry = queue.shift(); entry; entry = queue.shift()) {
          if (stopped || imageError) return
          let story: StoryInput
          try {
            const prepared = await prepare(
              entry,
              manifest.scope,
              get,
              images,
              work,
            )
            if (prepared.kind !== "change") continue
            // The Storybook story id names the page: context for the judge.
            story = { ...prepared.story, storyId: entry.storyId }
          } catch (error) {
            imageError ??= (error as Error).message
            return
          }
          const votes = await Promise.all(
            models.map((model) => ask(story, model)),
          )
          // A case that the cap stopped gets no panel: the next run judges
          // it again.
          if (votes.some((given) => given === undefined)) return
          const given = votes.filter((one) => one !== undefined)
          panels.set(entry.id, { label: agreement(given), votes: given })
        }
      }),
    )
  } finally {
    await rm(work, { recursive: true, force: true })
  }

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
  await writeFile(casesPath, `${JSON.stringify(next, null, 2)}\n`)

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
  const { spent } = spend.totals()
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
