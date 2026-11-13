// The owner calibration of the visual critic (CTX-1269). The product owner
// reviewed screenshots of main, and said what a critic must flag and what is
// fine. `owner-calibration.json` holds that feedback. This command judges each
// screenshot as a new screenshot (the image alone), with the arms of the
// bake-off runner, and counts, for each arm, the owner issues that it flags
// (hits) and the fine items that it flags (false flags). See README.md beside
// this file.
//
// Usage: node packages/visual-review/evals/critic/calibration.ts --arms <list>
//          [--calibration <path>] [--images <dir>] [--out <dir>] [--max-cost 2]

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { z } from "zod"

import { pngSize } from "../../src/prepare.ts"
import { packagedRubric, rubricId } from "../../src/rubric.ts"
import type { NewStoryInput } from "../../src/story.ts"
import type { Verdict } from "../../src/verdict.ts"
import { imageFile, imageStore, releaseUrl } from "./images.ts"
import { armOf, failed } from "./run.ts"
import { spendMeter } from "./spend.ts"

const usage = `Usage: node packages/visual-review/evals/critic/calibration.ts --arms <list> [--calibration <path>] [--images <dir>] [--out <dir>] [--max-cost 2]

  --arms         The arms of the bake-off runner that judge a new screenshot,
                 comma-separated, for example jev,llm:anthropic/claude-sonnet-5.5
  --calibration  The feedback file. Default: owner-calibration.json beside this file.
  --images       The folder of the images, as <sha256>.png. An image that is
                 not in it comes from the release visual-bakeoff-images.
                 Default: .ci-results/visual-bakeoff/images
  --out          The folder for results.json and report.md.
                 Default: .ci-results/visual-bakeoff/report
  --max-cost     The spend cap in USD, with the rules of the bake-off runner.
                 Default: 2

The key and the endpoint come from MODEL_PROVIDER_API_KEY and
MODEL_PROVIDER_URL. Exit code: 2 for a usage or input error; else 0.`

// The rubric ids that a judge flags an item of the owner with.
const kindsSchema = z.array(rubricId).min(1)

export const calibrationSchema = z.strictObject({
  /** The day of the review of the owner. */
  date: z.iso.date(),
  screenshots: z
    .array(
      z.strictObject({
        /** Where the screenshot was in the repository on that day. */
        path: z.string().min(1),
        /** The SHA-256 of the image: an asset of the image release. */
        image: z.string().regex(/^[0-9a-f]{64}$/),
        storyId: z.string().min(1),
        scope: z.enum(["page", "component"]),
        /** The issues that the owner wants a critic to flag. */
        flag: z.array(
          z.strictObject({ issue: z.string().min(1), kinds: kindsSchema }),
        ),
        /** The things that the owner said are fine. */
        ok: z.array(
          z.strictObject({ item: z.string().min(1), kinds: kindsSchema }),
        ),
      }),
    )
    .min(1),
})
export type Calibration = z.infer<typeof calibrationSchema>

/**
 * The rubric ids that a verdict flags: the kind of each finding, and each
 * quality that `fails`.
 */
const flaggedKinds = (verdict: Verdict) =>
  new Set([
    ...verdict.findings.map(({ kind }) => kind),
    ...verdict.qualities
      .filter(({ delta }) => delta === "fails")
      .map(({ name }) => name),
  ])

type Result = { arm: string; image: string; verdict: Verdict }

/**
 * The score of one verdict on one screenshot. An owner issue is a hit when
 * the verdict flags one of its kinds. A fine item is a false flag when the
 * verdict flags one of its kinds that no issue of the screenshot names: a
 * kind that an issue also names counts as a hit only. The count is by rubric
 * id, not by the text of a finding.
 */
function scoreOne(
  screenshot: Calibration["screenshots"][number],
  verdict: Verdict,
) {
  const flagged = flaggedKinds(verdict)
  const issueKinds = new Set(screenshot.flag.flatMap(({ kinds }) => kinds))
  return {
    hits: screenshot.flag.filter(({ kinds }) =>
      kinds.some((kind) => flagged.has(kind)),
    ),
    falseFlags: screenshot.ok.filter(({ kinds }) =>
      kinds.some((kind) => flagged.has(kind) && !issueKinds.has(kind)),
    ),
  }
}

/** The report: the totals of each arm, then each screenshot. */
function calibrationReport(
  calibration: Calibration,
  arms: readonly string[],
  results: readonly Result[],
  spent: number,
): string {
  const issues = calibration.screenshots.reduce((n, s) => n + s.flag.length, 0)
  const fine = calibration.screenshots.reduce((n, s) => n + s.ok.length, 0)
  const scored = results.map((result) => {
    const screenshot = calibration.screenshots.find(
      ({ image }) => image === result.image,
    )
    if (!screenshot) throw new Error(`No screenshot ${result.image}.`)
    return { ...result, screenshot, ...scoreOne(screenshot, result.verdict) }
  })
  const totals = arms.map((arm) => {
    const ofArm = scored.filter((result) => result.arm === arm)
    const sum = (count: (result: (typeof ofArm)[number]) => number) =>
      ofArm.reduce((n, result) => n + count(result), 0)
    return `| ${arm} | ${ofArm.length} | ${sum((r) => r.hits.length)} / ${issues} | ${sum((r) => r.falseFlags.length)} / ${fine} | ${sum((r) => (r.verdict.verdict === "regression" ? 1 : 0))} | ${sum((r) => (r.verdict.error ? 1 : 0))} |`
  })
  const rows = calibration.screenshots.map((screenshot) => {
    const cells = arms.map((arm) => {
      const result = scored.find(
        (r) => r.arm === arm && r.screenshot === screenshot,
      )
      if (!result) return "not run"
      const flagged = [...flaggedKinds(result.verdict)].join(", ") || "none"
      return `${result.hits.length} / ${screenshot.flag.length} hits, ${result.falseFlags.length} / ${screenshot.ok.length} false (${flagged})`
    })
    return `| ${screenshot.storyId} | ${cells.join(" | ")} |`
  })
  return [
    `# Owner calibration, ${calibration.date}`,
    "",
    "A hit is an owner issue that the arm flags. A false flag is a fine item that the arm flags.",
    "",
    "| Arm | Verdicts | Hits | False flags | Regression verdicts | Errors |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...totals,
    "",
    `| Screenshot | ${arms.join(" | ")} |`,
    `| --- | ${arms.map(() => "---").join(" | ")} |`,
    ...rows,
    "",
    `Spend: $${spent.toFixed(4)} (a call without a cost counts as at least $0.10).`,
  ].join("\n")
}

/**
 * Run the calibration with the command-line arguments `args`. `print` gets
 * the output. Returns the exit code.
 */
export async function calibrate(
  args: readonly string[],
  print: (text: string) => void,
): Promise<number> {
  let options
  let calibration: Calibration
  const arms: {
    id: string
    judgeNew: (story: NewStoryInput) => Promise<Verdict>
  }[] = []
  try {
    ;({ values: options } = parseArgs({
      args: [...args],
      strict: true,
      options: {
        arms: { type: "string" },
        calibration: {
          type: "string",
          default: join(import.meta.dirname, "owner-calibration.json"),
        },
        images: {
          type: "string",
          default: ".ci-results/visual-bakeoff/images",
        },
        out: { type: "string", default: ".ci-results/visual-bakeoff/report" },
        "max-cost": { type: "string", default: "2" },
      },
    }))
    if (!options.arms || !(Number(options["max-cost"]) >= 0))
      throw new Error(
        "--arms is required, and --max-cost is a number of 0 or more.",
      )
    for (const id of options.arms.split(",").map((arm) => arm.trim())) {
      const { judgeNew } = await armOf(id, {
        concurrency: 1,
        work: tmpdir(),
      })
      if (!judgeNew) throw new Error(`Arm "${id}" judges no new screenshot.`)
      arms.push({ id, judgeNew })
    }
    if (!process.env.MODEL_PROVIDER_API_KEY)
      throw new Error("Set MODEL_PROVIDER_API_KEY (the OpenRouter key).")
    calibration = calibrationSchema.parse(
      JSON.parse(await readFile(options.calibration, "utf8")),
    )
  } catch (error) {
    print(`${(error as Error).message}\n\n${usage}`)
    return 2
  }

  const spend = spendMeter(Number(options["max-cost"]))
  const images = resolve(options.images)
  const get = imageStore(images, releaseUrl)
  try {
    // The image store keeps each checked image in the image folder: the
    // judges read it there.
    const stories: NewStoryInput[] = []
    for (const { image, storyId, scope } of calibration.screenshots) {
      const size = pngSize(await get(image))
      if (!size) throw new Error(`The image ${image} is not a PNG.`)
      stories.push({
        storyId,
        scope,
        images: [{ path: join(images, imageFile(image)), size }],
        rubric: packagedRubric,
      })
    }
    // The arms run at the same time; each arm judges one screenshot at a
    // time. A failed call gets one retry while the spend is below the cap,
    // as in the bake-off runner.
    const results: Result[] = []
    await Promise.all(
      arms.map(async ({ id, judgeNew }) => {
        for (const [index, story] of stories.entries()) {
          if (!spend.open()) return
          let verdict: Verdict
          try {
            verdict = await judgeNew(story).catch((error: unknown) => {
              // The cost of the failed call is not known.
              spend.count(null)
              if (!spend.open()) throw error
              return judgeNew(story)
            })
          } catch (error) {
            verdict = failed(
              story,
              { model: id, costUsd: null, latencyMs: 0 },
              (error as Error).message,
            )
          }
          spend.count(verdict.costUsd)
          const image = calibration.screenshots[index]?.image ?? ""
          results.push({ arm: id, image, verdict })
        }
      }),
    )
    const { spent } = spend.totals()
    const text = calibrationReport(
      calibration,
      arms.map(({ id }) => id),
      results,
      spent,
    )
    const out = resolve(options.out)
    await mkdir(out, { recursive: true })
    await writeFile(
      join(out, "results.json"),
      `${JSON.stringify({ spent, results }, null, 2)}\n`,
    )
    await writeFile(join(out, "report.md"), `${text}\n`)
    print(text)
    return 0
  } catch (error) {
    print((error as Error).message)
    return 2
  }
}

if (import.meta.main)
  process.exitCode = await calibrate(process.argv.slice(2), (text) =>
    process.stdout.write(`${text}\n`),
  )
