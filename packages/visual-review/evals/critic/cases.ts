// The case manifest of the bake-off: cases.json, beside this file. The
// images are not in git: the manifest holds the SHA-256 of each image, and
// the image is the asset `<sha256>.png` of a public release (images.ts).

import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { z } from "zod"

import { noiseClasses, regressionClasses } from "./mutations.ts"

const count = z.number().int().nonnegative()
const sha = z.string().regex(/^[0-9a-f]{40}$/)
/** The SHA-256 of a PNG image, in hex. */
const image = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * The labels of the judge panel (CTX-1249): the after image is as good or
 * better and shows a real change, it breaks the rubric, or it shows no change
 * that a user sees.
 */
export const panelLabels = ["improvement", "regression", "no-change"] as const
export type PanelLabel = (typeof panelLabels)[number]

/**
 * The votes of the judge panel on a case, and the label that the agreement
 * rule gives (panel.ts), or null when the members do not agree. A vote with
 * an error has no label.
 */
const panel = z.object({
  label: z.enum(panelLabels).nullable(),
  votes: z.array(
    z.object({
      model: z.string(),
      label: z.enum(panelLabels).nullable(),
      reason: z.string(),
      error: z.string().optional(),
    }),
  ),
})
export type Panel = z.infer<typeof panel>

const common = {
  /** A stable id: the kind, the class and a hash. */
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** The Storybook story id. */
  storyId: z.string().min(1),
  /** A viewport of the visual check. A page story has both. */
  viewport: z.union([
    z.object({
      name: z.literal("desktop"),
      width: z.literal(1440),
      height: z.literal(900),
    }),
    z.object({
      name: z.literal("mobile"),
      width: z.literal(390),
      height: z.literal(844),
    }),
  ]),
  /** The pixels that differ (BlazeDiff, threshold 0.1). */
  diffPixels: count,
  images: z.object({ before: image, after: image }),
}
/**
 * The votes of the panel on a case with a before image. Absent until the
 * panel judges the case. A `new` case has no before image: the panel does
 * not judge it.
 */
const judged = { panel: panel.optional() }
/** The commit of a real change and its first parent. */
const commit = z.object({ sha, parent: sha })
/** The box of the synthetic change, in pixels of the after image. */
const region = z.object({ x: count, y: count, width: count, height: count })

/**
 * One case. `kind` says how the builder made it; `label` is the answer that
 * the critic must give. A case with the label `unsure` does not run.
 * - `intended`: a real commit, before and after. The brief is its message.
 *   The label is `unsure` until the judge panel agrees on one (panel.ts), or
 *   the owner labels the case in the queue (queue.ts).
 * - `regression`: one synthetic change of `class` on a clean render.
 * - `noise`: a change that a person does not see.
 * - `mixed`: a real commit, with a synthetic regression of `class` hidden in
 *   the after image.
 * - `new`: a story that a real commit added. There is no before image and no
 *   diff: the critic judges the after image on its own. With `class` null,
 *   it is the clean render (label `intended`); with a `class`, a synthetic
 *   regression of that class is in it (label `regression`, with its region).
 */
export const caseSchema = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    ...judged,
    kind: z.literal("intended"),
    label: z.enum(["intended", "regression", "noise", "unsure"]),
    class: z.null(),
    brief: z.string().min(1),
    commit,
    region: z.null(),
  }),
  z.object({
    ...common,
    ...judged,
    kind: z.literal("regression"),
    label: z.literal("regression"),
    class: z.enum(regressionClasses),
    brief: z.null(),
    commit: z.null(),
    region,
  }),
  z.object({
    ...common,
    ...judged,
    kind: z.literal("noise"),
    label: z.literal("noise"),
    class: z.enum(noiseClasses),
    brief: z.null(),
    commit: z.null(),
    region: z.null(),
  }),
  z.object({
    ...common,
    ...judged,
    kind: z.literal("mixed"),
    label: z.literal("regression"),
    class: z.enum(regressionClasses),
    brief: z.string().min(1),
    commit,
    region,
  }),
  z.object({
    ...common,
    kind: z.literal("new"),
    // The panel does not judge a new case: it has no votes.
    panel: z.never().optional(),
    label: z.enum(["intended", "regression"]),
    class: z.enum(regressionClasses).nullable(),
    brief: z.string().min(1),
    commit,
    region: region.nullable(),
    diffPixels: z.null(),
    // Strict: a new case that has a before image is not a new case.
    images: z.strictObject({ after: image }),
  }),
])
export type Case = z.infer<typeof caseSchema>

export const caseManifestSchema = z
  .object({
    $schema: z.literal("./cases.schema.json"),
    version: z.literal(1),
    /** The seed of the build. The same seed gives the same cases. */
    seed: z.number().int(),
    /** The newest commit of the history that the builder reads. */
    until: sha,
    /** The capture image, with its digest. */
    container: z.string(),
    /**
     * All stories are page stories (the `page` tag). The field stays on
     * purpose: the component stories become a second manifest with the
     * scope `component` (CTX-1249), and the judges read the scope here.
     */
    scope: z.literal("page"),
    /** The models of the judge panel, after a run of panel.ts. */
    panelModels: z.array(z.string()).optional(),
    cases: z.array(caseSchema),
    /**
     * The blind pairwise picks of the owner (CTX-1201): for one case, the
     * outputs of two bake-off arms, and the arm whose output the owner
     * prefers, or `tie`. Absent until the owner labels.
     */
    taste: z
      .array(
        z
          .object({
            case: z.string(),
            arms: z.tuple([z.string(), z.string()]),
            winner: z.string(),
          })
          .refine(({ arms, winner }) => [...arms, "tie"].includes(winner), {
            message: "The winner must be one of the two arms, or tie.",
          }),
      )
      .optional(),
  })
  .refine(
    (manifest) =>
      new Set(manifest.cases.map((entry) => entry.id)).size ===
      manifest.cases.length,
    { message: "Each case id must be unique." },
  )
  .refine(
    ({ cases, taste }) =>
      (taste ?? []).every((pick) => cases.some(({ id }) => id === pick.case)),
    { message: "Each taste pick must name a case of the manifest." },
  )
  .refine(
    (manifest) =>
      manifest.cases.every(
        (entry) =>
          entry.kind !== "new" ||
          (entry.class === null
            ? entry.region === null
            : entry.region !== null && entry.label === "regression"),
      ),
    {
      message:
        "A new case with a class has its region and the label regression; a new case with no class has no region.",
    },
  )
export type CaseManifest = z.infer<typeof caseManifestSchema>

export const caseManifestJsonSchema = z.toJSONSchema(caseManifestSchema)

/** Read and check the case manifest at `path`, or cases.json beside this file. */
export async function readManifest(path?: string): Promise<CaseManifest> {
  return caseManifestSchema.parse(
    JSON.parse(
      await readFile(
        resolve(path ?? join(import.meta.dirname, "cases.json")),
        "utf8",
      ),
    ),
  )
}
