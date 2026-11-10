// The case manifest of the bake-off: cases.json, beside this file. The
// images are not in git: the manifest holds the SHA-256 of each image, and
// the image is the asset `<sha256>.png` of a public release (images.ts).

import { z } from "zod"

import { noiseClasses, regressionClasses } from "./mutations.ts"

const count = z.number().int().nonnegative()
const sha = z.string().regex(/^[0-9a-f]{40}$/)
/** The SHA-256 of a PNG image, in hex. */
const image = z.string().regex(/^[0-9a-f]{64}$/)

const common = {
  /** A stable id: the kind, the class and a number. */
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** The Storybook story id. */
  storyId: z.string().min(1),
  viewport: z.object({
    name: z.literal("desktop"),
    width: z.literal(1440),
    height: z.literal(900),
  }),
  /** The pixels that differ (BlazeDiff, threshold 0.1). */
  diffPixels: count,
  images: z.object({ before: image, after: image }),
}
/** The commit of a real change and its first parent. */
const commit = z.object({ sha, parent: sha })
/** The box of the synthetic change, in pixels of the after image. */
const region = z.object({ x: count, y: count, width: count, height: count })

/**
 * One case. `kind` says how the builder made it; `label` is the answer that
 * the critic must give, and the owner can change it. The owner can label a
 * real change `unsure`: the run leaves that case out.
 * - `intended`: a real commit, before and after. The brief is its message.
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
    kind: z.literal("intended"),
    label: z.enum(["intended", "regression", "noise", "unsure"]),
    class: z.null(),
    brief: z.string().min(1),
    commit,
    region: z.null(),
  }),
  z.object({
    ...common,
    kind: z.literal("regression"),
    label: z.literal("regression"),
    class: z.enum(regressionClasses),
    brief: z.null(),
    commit: z.null(),
    region,
  }),
  z.object({
    ...common,
    kind: z.literal("noise"),
    label: z.literal("noise"),
    class: z.enum(noiseClasses),
    brief: z.null(),
    commit: z.null(),
    region: z.null(),
  }),
  z.object({
    ...common,
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
