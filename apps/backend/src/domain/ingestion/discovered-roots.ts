import { z } from "zod"

/**
 * The host check of the `discover-roots` result (ADR-052 section 1). The
 * script result is the evidence; a model can only choose among the
 * `candidates` of an `ambiguous` entry. The host plans the root steps from
 * the roots that this function gives, so a model cannot add a root without
 * script evidence, and it cannot remove a script root.
 */

const MAX_ROOTS = 2000

const RootSchema = z.object({
  path: z.string(),
  manifests: z.array(z.string()).max(50),
  evidence: z.array(z.string()).max(50),
})

const ScriptResultSchema = z.object({
  roots: z.array(RootSchema).max(MAX_ROOTS),
  ambiguous: z
    .array(
      z.object({
        manifest: z.string().nullable(),
        reason: z.string(),
        candidates: z
          .array(
            z.object({
              path: z.string(),
              manifests: z.array(z.string()).max(50),
            }),
          )
          .max(MAX_ROOTS),
      }),
    )
    .max(MAX_ROOTS),
})

const ModelResultSchema = z.object({
  roots: z.array(z.object({ path: z.string() })).max(MAX_ROOTS),
})

export type DiscoveredRoot = z.infer<typeof RootSchema>

export type RefusedRoot = { path: string | null; reason: string }

/**
 * Same rule as `safePath` in
 * ingest-skills/discover-roots/scripts/roots-lib.mjs: no control character
 * (C0 or C1), no newline or line separator, no invisible direction
 * character, no backtick, no `..`, at most 300 characters.
 */
function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 300 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the check refuses control and direction characters
    !/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069`]/.test(
      path,
    ) &&
    !path.includes("..")
  )
}

/**
 * The roots to plan: each script root as it is, plus each root that the
 * model chose from the `candidates` of an ambiguous entry, with
 * `evidence: ["model"]` and the script's manifests. Everything else is in
 * `refused`. `modelResult` is null when no model ran (no ambiguous entry).
 * Throws when the script result does not match its schema.
 */
export function resolveDiscoveredRoots(
  scriptResult: unknown,
  modelResult: unknown,
): { roots: DiscoveredRoot[]; refused: RefusedRoot[] } {
  const script = ScriptResultSchema.safeParse(scriptResult)
  if (!script.success)
    throw new Error(
      "The discover-roots script result does not match its schema",
    )
  const roots = new Map<string, DiscoveredRoot>()
  const refused: RefusedRoot[] = []
  for (const root of script.data.roots) {
    if (!safePath(root.path))
      refused.push({ path: root.path, reason: "The path is not safe to write" })
    else if (!roots.has(root.path)) roots.set(root.path, root)
  }
  const candidates = new Map(
    script.data.ambiguous.flatMap((entry) =>
      entry.candidates.map((c) => [c.path, c.manifests] as const),
    ),
  )

  if (modelResult !== null && modelResult !== undefined) {
    const model = ModelResultSchema.safeParse(modelResult)
    if (!model.success)
      refused.push({
        path: null,
        reason: "The model result does not match the discover-roots schema",
      })
    for (const { path } of model.success ? model.data.roots : []) {
      if (roots.has(path)) continue
      const manifests = candidates.get(path)
      if (!safePath(path))
        refused.push({ path, reason: "The path is not safe to write" })
      else if (!manifests)
        refused.push({
          path,
          reason: "The path is not a candidate of an ambiguous entry",
        })
      else roots.set(path, { path, manifests, evidence: ["model"] })
    }
  }

  return {
    roots: [...roots.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    refused,
  }
}
