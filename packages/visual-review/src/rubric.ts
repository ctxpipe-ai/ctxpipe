// The two-layer rubric of the visual critic. The rubric is data, in
// `rubric.json`: the factory gives `visual:review --rubric` the rubric of the
// PR head, while the code of the critic stays the merge-base code (ADR-063,
// CTX-1264). Thus a head rubric is text of the PR author, and this schema is
// its trust boundary. Each entry cites the section of our design docs that it
// comes from. A test makes sure that each cited section exists, so a renamed
// heading fails the test.
import { constants } from "node:fs"
import { open } from "node:fs/promises"

import { z } from "zod"

import packaged from "../rubric.json" with { type: "json" }

/** The id of an area or a quality: a `kind` of a finding, a quality name. */
export const rubricId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)

// Rubric text goes into each question to Jev and into the prompt of a model.
// One line of printable text: no control or format character and no line or
// paragraph separator (no new line, no bidi mark), and no `<` or `>`, so that
// the text cannot start a new line of the prompt, or open or close a <data>
// block.
const oneLineText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(
      /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]*$/u,
      "Use one line of printable text with no < or >.",
    )

const source = z.strictObject({
  file: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/)
    .refine((file) => !file.split("/").includes(".."), "No .. in a path."),
  section: oneLineText(120),
})

const entry = {
  id: rubricId,
  name: oneLineText(60),
  definition: oneLineText(1500),
  // A tuple, so that the type says that each entry has a first source.
  sources: z
    .tuple([source], source)
    .refine((sources) => sources.length <= 6, "Give at most 6 sources."),
}

const uniqueIds = (
  entries: readonly { id: string }[],
  context: z.RefinementCtx,
) => {
  const ids = entries.map(({ id }) => id)
  if (new Set(ids).size !== ids.length)
    context.addIssue({ code: "custom", message: "Each id must be unique." })
}

/**
 * The rubric. Layer 1, the concrete areas: a finding names one of them as its
 * `kind`. Layer 2, the design qualities: for each one, the critic says if the
 * change makes it better, the same or worse. A `pageOnly` quality applies
 * only to a story with the scope `page`.
 */
export const rubricSchema = z.strictObject({
  areas: z.array(z.strictObject(entry)).min(1).max(16).superRefine(uniqueIds),
  qualities: z
    .array(z.strictObject({ ...entry, pageOnly: z.boolean() }))
    .min(1)
    .max(16)
    .superRefine(uniqueIds),
})

export type Rubric = z.infer<typeof rubricSchema>
export type RubricEntry = Rubric["areas"][number]

/** The rubric of this checkout, `rubric.json`. */
export const packagedRubric: Rubric = rubricSchema.parse(packaged)

/**
 * Read a rubric file, such as the head rubric that the factory copies into
 * the review folder. The file must be a regular file (not a symbolic link) of
 * at most 64 KiB that matches `rubricSchema`. Else this throws with the
 * cause: the caller stops the review, and never falls back to another rubric.
 */
export async function readRubric(path: string): Promise<Rubric> {
  const max = 64 * 1024
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    throw new Error(
      (error as NodeJS.ErrnoException).code === "ELOOP"
        ? `The rubric ${path} is a symbolic link, which is refused.`
        : `Cannot read the rubric ${path}: ${(error as Error).message}`,
    )
  }
  let body: string
  try {
    const stat = await handle.stat()
    if (!stat.isFile())
      throw new Error(`The rubric ${path} is not a regular file.`)
    if (stat.size > max)
      throw new Error(`The rubric ${path} is larger than ${max} bytes.`)
    body = await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch (error) {
    throw new Error(
      `The rubric ${path} is not JSON: ${(error as Error).message}`,
    )
  }
  const parsed = rubricSchema.safeParse(json)
  if (!parsed.success)
    throw new Error(
      `The rubric ${path} does not match the schema:\n${z.prettifyError(parsed.error)}`,
    )
  return parsed.data
}
