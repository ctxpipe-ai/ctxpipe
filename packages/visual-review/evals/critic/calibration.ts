// The calibration of the visual critic. It has two sets (CTX-1289):
// - The owner examples (CTX-1269): the product owner reviewed screenshots,
//   and said what a critic must flag and what is fine.
//   `owner-calibration.json` holds that feedback.
// - The unseen set: screenshots that the owner did not review, labeled by
//   the judge panel (label-unseen.ts). `unseen-calibration.json` holds them.
// This command gives each screenshot to the bake-off runner as a new
// screenshot (the image alone), or as a change when the set has an earlier
// image (`before`, CTX-1282). It reports both sets side by side: for the
// unseen set, the recall on the defects and the false alarms on the fine
// screenshots; for the owner examples, the owner issues that each arm flags
// (hits) and the fine items that it flags (false flags). A critic change is
// selected on the unseen set (ADR-063, rule 16). See README.md beside this
// file.
//
// Usage: node packages/visual-review/evals/critic/calibration.ts --arms <list>
//          [--calibration <path>] [--unseen <path>] [--images <dir>]
//          [--out <dir>] [--max-cost 4]

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { z } from "zod"

import { rubricId } from "../../src/rubric.ts"
import type { Verdict } from "../../src/verdict.ts"
import type { Case, CaseManifest } from "./cases.ts"
import type { Result } from "./report.ts"
import { bakeOff } from "./run.ts"

const usage = `Usage: node packages/visual-review/evals/critic/calibration.ts --arms <list> [--calibration <path>] [--unseen <path>] [--images <dir>] [--out <dir>] [--max-cost 4]

  --arms         The arms of the bake-off runner that judge a new or a
                 changed screenshot, comma-separated, for example jev,llm:anthropic/claude-sonnet-5.5
  --calibration  The owner examples. Default: owner-calibration.json beside this file.
  --unseen       The unseen set. Default: unseen-calibration.json beside this file.
  --images       The image folder of the runner. Default: .ci-results/visual-bakeoff/images
  --out          The folder for report.md, and for the cases, the results and
                 the report of the runner in runner/.
                 Default: .ci-results/visual-bakeoff/report
  --max-cost     The spend cap of the runner in USD. Default: 4

The key and the endpoint come from MODEL_PROVIDER_API_KEY and
MODEL_PROVIDER_URL. Exit code: the exit code of the runner, or 2 for a usage
or input error.`

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
/**
 * The earlier state, when the screenshot is a change: the SHA-256 of the
 * before image and the brief of the change. Then the case is a change with a
 * brief.
 */
const before = z.strictObject({ image: sha256, brief: z.string().min(1) })

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
        image: sha256,
        /** The story id, also the case id in the runner. */
        storyId: z.string().regex(/^[a-z0-9-]+$/),
        scope: z.enum(["page", "component"]),
        /** The review round of the owner that named the items. */
        round: z.number().int().min(1),
        /** When the owner judged a change: the issues are its regressions. */
        before: before.optional(),
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
 * The labels of the panel on an unseen screenshot: it breaks the rubric, or
 * it follows it. For a change, `defect` is the panel label `regression` of a
 * change, and `fine` is `improvement` or `no-change`.
 */
export const unseenLabels = ["defect", "fine"] as const
export type UnseenLabel = (typeof unseenLabels)[number]

export const unseenSchema = z
  .strictObject({
    /** The day of the selection of the screenshots. */
    selected: z.iso.date(),
    /** The models of the judge panel, after a run of label-unseen.ts. */
    panelModels: z.array(z.string()).optional(),
    screenshots: z
      .array(
        z.strictObject({
          /** The case id in the runner. */
          id: z.string().regex(/^[a-z0-9-]+$/),
          /**
           * Where the screenshot comes from: `main` (a screenshot of main),
           * `pr-722-round-3` (round 3 of PR 722, which the owner called a
           * regression overall), `pr-717` (a regression that the design
           * review of PR 717 found).
           */
          source: z.enum(["main", "pr-722-round-3", "pr-717"]),
          /** The screenshot file, at `commit`. */
          path: z.string().min(1),
          commit: z.string().regex(/^[0-9a-f]{40}$/),
          /** The SHA-256 of the image: an asset of the image release. */
          image: sha256,
          scope: z.enum(["page", "component"]),
          viewport: z.enum(["desktop", "mobile"]),
          before: before.optional(),
          /**
           * The votes of the judge panel, and the label of the agreement
           * rule (label-unseen.ts), or null when the members do not agree.
           * Absent until the panel judges the screenshot.
           */
          panel: z
            .strictObject({
              label: z.enum(unseenLabels).nullable(),
              votes: z.array(
                z.strictObject({
                  model: z.string(),
                  label: z.enum(unseenLabels).nullable(),
                  reason: z.string(),
                  error: z.string().optional(),
                }),
              ),
            })
            .optional(),
        }),
      )
      .min(1),
  })
  .refine(
    ({ screenshots }) =>
      new Set(screenshots.map(({ id }) => id)).size === screenshots.length,
    { message: "Each id must be unique." },
  )
export type Unseen = z.infer<typeof unseenSchema>

/** The brief of a screenshot with no earlier image, the same for each one. */
const newBrief = "A screenshot of main for a design review."

/**
 * The case of the runner for one screenshot of a calibration set: a `new`
 * case, or a change (`intended` kind, with its brief) when it has a `before`
 * image. The runner needs a commit, a label and a diff size; the screenshots
 * have none, so these fields are fixed placeholders that no score reads. The
 * runner measures the diff of a change itself. The judge panel of the unseen
 * set prepares a screenshot with the same case.
 */
export function screenshotCase(screenshot: {
  id: string
  image: string
  scope: "page" | "component"
  viewport: "desktop" | "mobile"
  before?: { image: string; brief: string } | undefined
}): Case {
  const none = "0".repeat(40)
  const common = {
    id: screenshot.id,
    storyId: screenshot.id,
    scope: screenshot.scope,
    viewport:
      screenshot.viewport === "desktop"
        ? ({ name: "desktop", width: 1440, height: 900 } as const)
        : ({ name: "mobile", width: 390, height: 844 } as const),
    class: null,
    commit: { sha: none, parent: none },
    region: null,
  }
  return screenshot.before
    ? {
        ...common,
        kind: "intended",
        label: "regression",
        brief: screenshot.before.brief,
        diffPixels: 0,
        images: { before: screenshot.before.image, after: screenshot.image },
      }
    : {
        ...common,
        kind: "new",
        label: "intended",
        brief: newBrief,
        diffPixels: null,
        images: { after: screenshot.image },
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
 * The score of one verdict on one owner screenshot. An owner issue is a hit
 * when the verdict flags one of its kinds. A fine item is a false flag when
 * the verdict flags one of its kinds that no issue of the screenshot names: a
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

/**
 * The report: the totals of each arm on both sets, then each unseen
 * screenshot, then each owner screenshot.
 */
function calibrationReport(
  owner: Calibration,
  unseen: Unseen,
  arms: readonly string[],
  results: readonly Result[],
  spent: number,
  stopped: string | null,
): string {
  const issues = owner.screenshots.reduce((n, s) => n + s.flag.length, 0)
  const fine = owner.screenshots.reduce((n, s) => n + s.ok.length, 0)
  const ownerScored = results.flatMap((result) => {
    const screenshot = owner.screenshots.find(
      ({ storyId }) => storyId === result.case,
    )
    return screenshot
      ? [{ ...result, screenshot, ...scoreOne(screenshot, result.verdict) }]
      : []
  })
  const resultsOfLabeled = results.flatMap((result) => {
    const screenshot = unseen.screenshots.find(({ id }) => id === result.case)
    const label = screenshot?.panel?.label
    return screenshot && label ? [{ ...result, screenshot, label }] : []
  })
  const labeledUnseen = unseen.screenshots.filter(({ panel }) => panel?.label)
  const count = <T>(items: readonly T[], test: (item: T) => boolean) =>
    items.filter(test).length
  const flagged = (verdict: Verdict) => verdict.verdict === "regression"

  const totals = arms.map((arm) => {
    const ofUnseen = resultsOfLabeled.filter((result) => result.arm === arm)
    const defects = ofUnseen.filter(({ label }) => label === "defect")
    const fines = ofUnseen.filter(({ label }) => label === "fine")
    const ofOwner = ownerScored.filter((result) => result.arm === arm)
    const sum = (n: (result: (typeof ofOwner)[number]) => number) =>
      ofOwner.reduce((total, result) => total + n(result), 0)
    const errors = count(
      [...ofUnseen, ...ofOwner],
      ({ verdict }) => !!verdict.error,
    )
    // A score with a missing or failed verdict cannot select a change.
    const complete =
      count(ofUnseen, ({ verdict }) => !verdict.error) === labeledUnseen.length
    return `| ${arm}${complete ? "" : " (incomplete)"} | ${count(defects, ({ verdict }) => flagged(verdict))} / ${defects.length} | ${count(fines, ({ verdict }) => flagged(verdict))} / ${fines.length} | ${count(ofUnseen, ({ verdict }) => verdict.verdict === "unsure")} / ${ofUnseen.length} | ${sum((r) => r.hits.length)} / ${issues} | ${sum((r) => r.falseFlags.length)} / ${fine} | ${sum((r) => (flagged(r.verdict) ? 1 : 0))} / ${ofOwner.length} | ${errors} |`
  })
  const verdictOf = (arm: string, id: string) =>
    results.find((result) => result.arm === arm && result.case === id)?.verdict
  const unseenRows = labeledUnseen.map((screenshot) => {
    const cells = arms.map(
      (arm) => verdictOf(arm, screenshot.id)?.verdict ?? "not run",
    )
    const name = `${screenshot.id}${screenshot.before ? " (change)" : ""}`
    return `| ${name} | ${screenshot.source} | ${screenshot.panel?.label} | ${cells.join(" | ")} |`
  })
  const ownerRows = owner.screenshots.map((screenshot) => {
    const cells = arms.map((arm) => {
      const result = ownerScored.find(
        (r) => r.arm === arm && r.screenshot === screenshot,
      )
      if (!result) return "not run"
      const kinds = [...flaggedKinds(result.verdict)].join(", ") || "none"
      return `${result.hits.length} / ${screenshot.flag.length} hits, ${result.falseFlags.length} / ${screenshot.ok.length} false (${kinds})`
    })
    const name = `${screenshot.storyId}${screenshot.before ? " (change)" : ""}`
    return `| ${screenshot.round} | ${name} | ${cells.join(" | ")} |`
  })
  const unlabeled = count(unseen.screenshots, ({ panel }) => !panel)
  const disputed = count(
    unseen.screenshots,
    ({ panel }) => !!panel && panel.label === null,
  )
  return [
    `# Calibration of the visual critic`,
    "",
    ...(stopped
      ? [
          `The run stopped early (${stopped}). Some screenshots have no verdict.`,
          "",
        ]
      : []),
    `Unseen set: ${labeledUnseen.length} of ${unseen.screenshots.length} screenshots have a panel label (${count(labeledUnseen, ({ panel }) => panel?.label === "defect")} defect, ${count(labeledUnseen, ({ panel }) => panel?.label === "fine")} fine). ${disputed} without agreement and ${unlabeled} with no panel run do not count. A critic change is selected on the unseen set (ADR-063, rule 16). An arm marked "(incomplete)" has a missing or failed verdict on a labeled unseen screenshot: its scores do not select a change.`,
    "",
    `Owner examples (${owner.date}): ${owner.screenshots.length} screenshots, ${issues} issues, ${fine} fine items. A hit is an owner issue that the arm flags. A false flag is a fine item that the arm flags.`,
    "",
    "| Arm | Unseen: defects flagged | Unseen: fine flagged | Unseen: unsure | Owner: hits | Owner: false flags | Owner: regression verdicts | Errors |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...totals,
    "",
    "## Unseen set",
    "",
    `| Screenshot | Source | Panel | ${arms.join(" | ")} |`,
    `| --- | --- | --- | ${arms.map(() => "---").join(" | ")} |`,
    ...unseenRows,
    "",
    "## Owner examples",
    "",
    `| Round | Screenshot | ${arms.join(" | ")} |`,
    `| ---: | --- | ${arms.map(() => "---").join(" | ")} |`,
    ...ownerRows,
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
  let owner: Calibration
  let unseen: Unseen
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
        unseen: {
          type: "string",
          default: join(import.meta.dirname, "unseen-calibration.json"),
        },
        images: {
          type: "string",
          default: ".ci-results/visual-bakeoff/images",
        },
        out: { type: "string", default: ".ci-results/visual-bakeoff/report" },
        "max-cost": { type: "string", default: "4" },
      },
    }))
    if (!options.arms) throw new Error("--arms is required.")
    owner = calibrationSchema.parse(
      JSON.parse(await readFile(options.calibration, "utf8")),
    )
    unseen = unseenSchema.parse(
      JSON.parse(await readFile(options.unseen, "utf8")),
    )
  } catch (error) {
    print(`${(error as Error).message}\n\n${usage}`)
    return 2
  }
  // Only an unseen screenshot with a panel label counts, so only those run.
  const cases = [
    ...owner.screenshots.map((screenshot) =>
      screenshotCase({
        ...screenshot,
        id: screenshot.storyId,
        viewport: "desktop",
      }),
    ),
    ...unseen.screenshots
      .filter(({ panel }) => panel?.label)
      .map((screenshot) => screenshotCase(screenshot)),
  ]
  const ids = cases.map(({ id }) => id)
  const twice = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (twice.length) {
    print(`The two sets both have the id ${twice.join(", ")}.\n\n${usage}`)
    return 2
  }
  const manifest: CaseManifest = {
    $schema: "./cases.schema.json",
    version: 1,
    seed: 0,
    until: "0".repeat(40),
    container: "none",
    scope: "page",
    cases,
  }

  const out = resolve(options.out)
  const runner = join(out, "runner")
  await mkdir(runner, { recursive: true })
  const casesPath = join(runner, "cases.json")
  await writeFile(casesPath, `${JSON.stringify(manifest, null, 2)}\n`)
  let runnerOutput = ""
  const code = await bakeOff(
    [
      "--arms",
      options.arms,
      "--cases",
      casesPath,
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
  const { arms, spent, stopped, results } = JSON.parse(
    await readFile(join(runner, "results.json"), "utf8"),
  ) as {
    arms: string[]
    spent: number
    stopped: string | null
    results: Result[]
  }
  const text = calibrationReport(owner, unseen, arms, results, spent, stopped)
  await writeFile(join(out, "report.md"), `${text}\n`)
  print(text)
  return 0
}

if (import.meta.main)
  process.exitCode = await calibrate(process.argv.slice(2), (text) =>
    process.stdout.write(`${text}\n`),
  )
