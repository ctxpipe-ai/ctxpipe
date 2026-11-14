// The owner calibration of the visual critic (CTX-1269). The product owner
// reviewed screenshots of main, and said what a critic must flag and what is
// fine. `owner-calibration.json` holds that feedback. This command gives each
// screenshot to the bake-off runner as a new screenshot (the image alone), or
// as a change when the owner judged a change against an earlier image
// (`before`, CTX-1282), and counts, for each arm, the owner issues that it
// flags (hits) and the fine items that it flags (false flags). See README.md
// beside this file.
//
// Usage: node packages/visual-review/evals/critic/calibration.ts --arms <list>
//          [--calibration <path>] [--images <dir>] [--out <dir>] [--max-cost 2]

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { z } from "zod"

import { rubricId } from "../../src/rubric.ts"
import type { Verdict } from "../../src/verdict.ts"
import type { CaseManifest } from "./cases.ts"
import type { Result } from "./report.ts"
import { bakeOff } from "./run.ts"

const usage = `Usage: node packages/visual-review/evals/critic/calibration.ts --arms <list> [--calibration <path>] [--images <dir>] [--out <dir>] [--max-cost 2]

  --arms         The arms of the bake-off runner that judge a new or a
                 changed screenshot, comma-separated, for example jev,llm:anthropic/claude-sonnet-5.5
  --calibration  The feedback file. Default: owner-calibration.json beside this file.
  --images       The image folder of the runner. Default: .ci-results/visual-bakeoff/images
  --out          The folder for report.md, and for the cases, the results and
                 the report of the runner in runner/.
                 Default: .ci-results/visual-bakeoff/report
  --max-cost     The spend cap of the runner in USD. Default: 2

The key and the endpoint come from MODEL_PROVIDER_API_KEY and
MODEL_PROVIDER_URL. Exit code: the exit code of the runner, or 2 for a usage
or input error.`

// The rubric ids that a judge flags an item of the owner with.
const kindsSchema = z.array(rubricId).min(1)

export const calibrationSchema = z.strictObject({
  /** The day of the first review round of the owner. */
  date: z.iso.date(),
  screenshots: z
    .array(
      z.strictObject({
        /** Where the screenshot was in the repository on that day. */
        path: z.string().min(1),
        /** The SHA-256 of the image: an asset of the image release. */
        image: z.string().regex(/^[0-9a-f]{64}$/),
        /** The story id, also the case id in the runner. */
        storyId: z.string().regex(/^[a-z0-9-]+$/),
        scope: z.enum(["page", "component"]),
        /** The review round of the owner that named the items. */
        round: z.number().int().min(1),
        /**
         * The earlier state, when the owner judged a change: the SHA-256 of
         * the before image and the brief of the change. Then the issues are
         * regressions of the change, and the case is a change with a brief.
         */
        before: z
          .strictObject({
            image: z.string().regex(/^[0-9a-f]{64}$/),
            brief: z.string().min(1),
          })
          .optional(),
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
 * The case manifest of the runner: each screenshot is a `new` case, or a
 * change (`intended` kind, with its brief) when it has a `before` image. The
 * runner needs a commit, a label and a diff size; the screenshots have none,
 * so these fields are fixed placeholders that no score reads. The runner
 * measures the diff of a change itself.
 */
function manifestOf({ screenshots }: Calibration): CaseManifest {
  const none = "0".repeat(40)
  return {
    $schema: "./cases.schema.json",
    version: 1,
    seed: 0,
    until: none,
    container: "none",
    scope: "page",
    cases: screenshots.map(({ storyId, image, scope, before }) => {
      const common = {
        id: storyId,
        storyId,
        scope,
        viewport: { name: "desktop", width: 1440, height: 900 },
        class: null,
        commit: { sha: none, parent: none },
        region: null,
      } as const
      return before
        ? {
            ...common,
            kind: "intended",
            label: "regression",
            brief: before.brief,
            diffPixels: 0,
            images: { before: before.image, after: image },
          }
        : {
            ...common,
            kind: "new",
            label: "intended",
            brief: "A screenshot of main for the design review of the owner.",
            diffPixels: null,
            images: { after: image },
          }
    }),
  }
}

/**
 * The rubric ids that a verdict flags: the kind of each finding, and each
 * quality that `fails` (a new screenshot) or is `worse` (a change).
 */
const flaggedKinds = (verdict: Verdict) =>
  new Set([
    ...verdict.findings.map(({ kind }) => kind),
    ...verdict.qualities
      .filter(({ delta }) => delta === "fails" || delta === "worse")
      .map(({ name }) => name),
  ])

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
      ({ storyId }) => storyId === result.case,
    )
    if (!screenshot) throw new Error(`No screenshot ${result.case}.`)
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
    const name = `${screenshot.storyId}${screenshot.before ? " (change)" : ""}`
    return `| ${screenshot.round} | ${name} | ${cells.join(" | ")} |`
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
    `| Round | Screenshot | ${arms.join(" | ")} |`,
    `| ---: | --- | ${arms.map(() => "---").join(" | ")} |`,
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
    if (!options.arms) throw new Error("--arms is required.")
    calibration = calibrationSchema.parse(
      JSON.parse(await readFile(options.calibration, "utf8")),
    )
  } catch (error) {
    print(`${(error as Error).message}\n\n${usage}`)
    return 2
  }

  const out = resolve(options.out)
  const runner = join(out, "runner")
  await mkdir(runner, { recursive: true })
  const cases = join(runner, "cases.json")
  await writeFile(
    cases,
    `${JSON.stringify(manifestOf(calibration), null, 2)}\n`,
  )
  let runnerOutput = ""
  const code = await bakeOff(
    [
      "--arms",
      options.arms,
      "--cases",
      cases,
      "--runs",
      "1",
      "--max-cost",
      options["max-cost"],
      "--images",
      options.images,
      "--out",
      runner,
    ],
    (text) => (runnerOutput += text),
  )
  if (code !== 0) {
    print(runnerOutput)
    return code
  }
  const { arms, spent, results } = JSON.parse(
    await readFile(join(runner, "results.json"), "utf8"),
  ) as { arms: string[]; spent: number; results: Result[] }
  const text = calibrationReport(calibration, arms, results, spent)
  await writeFile(join(out, "report.md"), `${text}\n`)
  print(text)
  return 0
}

if (import.meta.main)
  process.exitCode = await calibrate(process.argv.slice(2), (text) =>
    process.stdout.write(`${text}\n`),
  )
