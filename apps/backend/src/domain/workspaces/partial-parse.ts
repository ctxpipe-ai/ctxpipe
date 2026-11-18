import type { StoredIndexedUnit } from "../../models/workspaces.js"
import { effectiveValidFrom } from "./hydrate-phases.js"
import {
  applyEffectiveValidFromToUnits,
  deriveKnowledgeUnits,
  type HydrateSkip,
  type HydrateUnit,
  type KnowledgePlanFacts,
  LEGACY_UNIT_SOURCE,
  parseKnowledgeFiles,
  REFERENCE_INDEX_VERSION,
  type UnitReferenceIndex,
} from "./hydrate.js"

/**
 * The reasons for a full parse (a read and a parse of each file) instead of
 * a partial parse (the changed files only):
 *
 * - `full_write`: the Postgres write is a full write, which needs all units
 *   (`HydrateFullReason` gives the cause).
 * - `no_reference_index`: a stored unit has no reference index (the first
 *   hydrate after the index came).
 * - `reference_index_version`: a stored index has another
 *   `REFERENCE_INDEX_VERSION`.
 * - `legacy_overlay`: the projection holds or can get main-era knowledge
 *   from Postgres (`legacyKnowledgeOverlay`). The overlay reads each file.
 * - `base_not_ancestor`: the base SHA is not an ancestor of the new SHA in
 *   the history that the read fetches, so the commit times of the changed
 *   files are not known.
 */
export type HydrateParseFullReason =
  | "full_write"
  | "no_reference_index"
  | "reference_index_version"
  | "legacy_overlay"
  | "base_not_ancestor"

/**
 * The reason for a full parse that the stored index gives before any read,
 * or null when a partial parse can start.
 */
export function storedIndexFullReason(stored: {
  units: readonly StoredIndexedUnit[]
  skipped: readonly HydrateSkip[]
}): HydrateParseFullReason | null {
  if (stored.units.some((unit) => unit.referenceIndex === null))
    return "no_reference_index"
  if (
    stored.units.some(
      (unit) => unit.referenceIndex?.version !== REFERENCE_INDEX_VERSION,
    )
  )
    return "reference_index_version"
  if (
    stored.units.some((unit) => unit.source === LEGACY_UNIT_SOURCE) ||
    stored.skipped.some((skip) => skip.source === "legacy-overlay")
  )
    return "legacy_overlay"
  return null
}

/** The order of `git ls-tree`: the bytes of each path. */
function treeOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

/**
 * The hydrate parse of a tree from the stored units and the changed files.
 *
 * 1. Parse the files that changed since the base, and the files that the
 *    base skipped (a skip has no stored index).
 * 2. Join their reference indexes with the stored indexes of the other units,
 *    in tree order, and compute the links, the claims and the plan facts of
 *    all units from the indexes (`deriveKnowledgeUnits`), with no file read.
 * 3. A stored unit whose new values differ from its row is affected (for
 *    example, it names a key that the change added or removed). Read its
 *    body from Postgres and make the unit again.
 *
 * The result has the units that can differ from their rows (the parsed and
 * the affected units), the stored units that the tip removed, and the values
 * of the complete tree that hydrate needs (the skips, the plan facts, the
 * unit count, and each unit for the graph).
 */
export async function partialKnowledgeParse(input: {
  workspaceId: string
  workspaceUrl: string
  stored: readonly StoredIndexedUnit[]
  /** The files that the read gave: the changed files and the control files. */
  files: ReadonlyArray<{
    path: string
    content: string
    introducingCommitTimestamp?: string
    lastCommitTimestamp?: string
  }>
  /** The Markdown paths that changed since the base. */
  changed: readonly string[]
  /** The Markdown paths that the tip removed. */
  removed: readonly string[]
  /** The skips of the base. */
  previousSkipped: readonly HydrateSkip[]
  confluenceSiteHosts: ReadonlySet<string>
  sourceRepositories: ReadonlyMap<string, string>
  loadBodies: (servingIds: readonly string[]) => Promise<Map<string, string>>
}): Promise<{
  /** The parsed and the affected units, with the effective valid_from. */
  units: HydrateUnit[]
  removedUnitIds: string[]
  skipped: HydrateSkip[]
  facts: KnowledgePlanFacts[]
  /** Each unit of the tree as Postgres stores it after the commit. */
  allUnits: HydrateUnit[]
  filesParsed: number
}> {
  const storedByPath = new Map(input.stored.map((unit) => [unit.path, unit]))
  const removed = new Set(input.removed)
  const reparse = new Set([
    ...input.changed,
    ...input.previousSkipped.map((skip) => skip.path),
  ])
  const files = input.files
    .filter((file) => reparse.has(file.path))
    .map((file) => {
      const stored = storedByPath.get(file.path)
      // A commit between the base and the tip that touched the path gives
      // its times. Else the times of the base stay: the full history walk
      // finds the same commits.
      const introducingCommitTimestamp =
        file.introducingCommitTimestamp ??
        stored?.referenceIndex?.introducedAt ??
        undefined
      const lastCommitTimestamp =
        file.lastCommitTimestamp ?? stored?.updatedAt ?? undefined
      return {
        ...file,
        ...(introducingCommitTimestamp ? { introducingCommitTimestamp } : {}),
        ...(lastCommitTimestamp ? { lastCommitTimestamp } : {}),
      }
    })
  const parsed = parseKnowledgeFiles({
    workspaceId: input.workspaceId,
    workspaceUrl: input.workspaceUrl,
    files,
  })
  const parsedPaths = new Set(parsed.units.map((unit) => unit.path))
  const kept = input.stored.filter(
    (unit) => !removed.has(unit.path) && !reparse.has(unit.path),
  )
  const removedUnitIds = input.stored
    .filter(
      (unit) =>
        (removed.has(unit.path) || reparse.has(unit.path)) &&
        !parsedPaths.has(unit.path),
    )
    .map((unit) => unit.servingId)
  const index = (unit: StoredIndexedUnit): UnitReferenceIndex => {
    if (!unit.referenceIndex) throw new Error("A stored unit has no index")
    return unit.referenceIndex
  }
  const entries = [
    ...kept.map((unit) => ({ path: unit.path, referenceIndex: index(unit) })),
    ...parsed.units,
  ].sort((a, b) => treeOrder(a.path, b.path))
  const derived = deriveKnowledgeUnits({
    units: entries,
    workspaceUrl: input.workspaceUrl,
    confluenceSiteHosts: input.confluenceSiteHosts,
    sourceRepositories: input.sourceRepositories,
  })

  for (const unit of parsed.units) {
    const values = derived.get(unit.path)
    if (!values) continue
    unit.links = values.links
    unit.claims = values.claims
    unit.referenceIndex.plan = { ...unit.referenceIndex.plan, ...values.plan }
  }
  const changedUnits = applyEffectiveValidFromToUnits(
    parsed.units,
    new Map(
      parsed.units.flatMap((unit) =>
        unit.referenceIndex.introducedAt
          ? [[unit.path, unit.referenceIndex.introducedAt] as const]
          : [],
      ),
    ),
  )

  // A kept unit is affected when a value that depends on other files changed.
  const affected: Array<{
    unit: StoredIndexedUnit
    referenceIndex: UnitReferenceIndex
    links: string[]
    claims: HydrateUnit["claims"]
  }> = []
  const facts: KnowledgePlanFacts[] = [
    ...parsed.units.map((unit) => unit.referenceIndex.plan),
    ...parsed.skippedFacts,
  ]
  for (const unit of kept) {
    const before = index(unit)
    const values = derived.get(unit.path)
    if (!values) continue
    const claims = values.claims.map((claim) => ({
      ...claim,
      validFrom: effectiveValidFrom({
        recorded: claim.validFrom,
        introducingCommitTimestamp: before.introducedAt,
      }),
    }))
    const plan = { ...before.plan, ...values.plan }
    facts.push(plan)
    // Postgres stores jsonb with its own key order: compare the fields.
    const fields = (
      links: readonly string[],
      list: HydrateUnit["claims"],
      facts: KnowledgePlanFacts,
    ) =>
      JSON.stringify([
        links,
        list.map((claim) => [
          claim.to,
          claim.predicate,
          claim.confidence,
          claim.validFrom,
          claim.validTo,
          claim.source,
        ]),
        facts.claimsUpgrade,
        facts.validFromPersist,
      ])
    if (
      fields(values.links, claims, plan) ===
      fields(unit.links, unit.claims, before.plan)
    )
      continue
    affected.push({
      unit,
      referenceIndex: { ...before, plan },
      links: values.links,
      claims,
    })
  }
  const bodies = await input.loadBodies(
    affected.map(({ unit }) => unit.servingId),
  )
  const affectedUnits: HydrateUnit[] = affected.map(
    ({ unit, referenceIndex, links, claims }) => {
      const body = bodies.get(unit.servingId)
      if (body === undefined) throw new Error("A stored unit has no body")
      return {
        path: unit.path,
        servingId: unit.servingId,
        kind: unit.kind,
        body,
        links,
        claims,
        generatedBy: referenceIndex.generatedBy,
        hasClaimWithoutEvidence: referenceIndex.hasClaimWithoutEvidence,
        title: unit.title,
        source: unit.source ?? "authored",
        updatedAt: unit.updatedAt,
        bodyStartLine: referenceIndex.bodyStartLine,
        referenceIndex,
      }
    },
  )
  const units = [...changedUnits, ...affectedUnits]
  const written = new Map(units.map((unit) => [unit.servingId, unit]))
  const allUnits = [
    ...kept.map(
      (unit): HydrateUnit =>
        written.get(unit.servingId) ?? {
          path: unit.path,
          servingId: unit.servingId,
          kind: unit.kind,
          body: "",
          links: unit.links,
          claims: unit.claims,
          title: unit.title,
          source: unit.source ?? "authored",
          updatedAt: unit.updatedAt,
        },
    ),
    ...changedUnits,
  ]
  return {
    units,
    removedUnitIds,
    skipped: [...parsed.skipped].sort((a, b) => treeOrder(a.path, b.path)),
    facts,
    allUnits,
    filesParsed: files.length,
  }
}
