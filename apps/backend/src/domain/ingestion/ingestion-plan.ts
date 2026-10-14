import { createHash } from "node:crypto"
import type { ModelTier } from "../../retrieval/services/providers/providerTypes.js"
import {
  type DiscoveredRoot,
  type RefusedRoot,
  resolveDiscoveredRoots,
} from "./discovered-roots.js"

/*
 * The plan of an ingestion v2 run (ADR-052, concept section 2): how the
 * parent splits the source roots into shards, and which skill steps a shard
 * runs. The plan is a function of the source SHA and the skill bundle, so a
 * replayed run makes the same steps.
 */

/** One shard takes at most this many roots (concept section 8). */
export const INGEST_SHARD_MAX_ROOTS = 20

/** A run plans at most this many roots; above it, the run is `partial`. */
export const INGEST_MAX_ROOTS = 400

/**
 * The roots of the run: the `discover-roots` script result after the host
 * check (`resolveDiscoveredRoots`, the only check), sorted and with no
 * duplicate. Above `INGEST_MAX_ROOTS` the run plans no root and gives a
 * `partial` reason. No model chooses among ambiguous candidates yet.
 */
export function planIngestRoots(
  scriptResult: unknown,
):
  | { roots: DiscoveredRoot[]; refused: RefusedRoot[]; partial?: undefined }
  | { partial: string; refused: RefusedRoot[] } {
  const { roots, refused } = resolveDiscoveredRoots(scriptResult, null)
  if (roots.length > INGEST_MAX_ROOTS)
    return {
      partial: `discover-roots found ${roots.length} roots; a run takes at most ${INGEST_MAX_ROOTS}`,
      refused,
    }
  return { roots, refused }
}

export type IngestSkillPlan = {
  name: string
  /** `root`: one step for each root; `repository`: one step on the assembled ref. */
  scope: "root" | "repository"
  /** `script`: a plain command; `model`: one OpenCode run. */
  run: "script" | "model"
  tier?: ModelTier
}

/**
 * The skills in their run order (concept section 8). A skill runs only when
 * the bundle holds it. `discover-roots` is not here: each shard runs it first,
 * and its result plans the root steps.
 */
const INGEST_SKILLS: readonly IngestSkillPlan[] = [
  { name: "classify-kind", scope: "root", run: "model", tier: "fast" },
  { name: "apis", scope: "root", run: "model", tier: "medium" },
  { name: "dependencies", scope: "root", run: "model", tier: "medium" },
  { name: "datasources-infra", scope: "root", run: "model", tier: "medium" },
  // `libraries` writes shared files, so it runs on the assembled ref.
  { name: "libraries", scope: "repository", run: "script" },
  { name: "ownership", scope: "repository", run: "script" },
  { name: "decisions", scope: "repository", run: "model", tier: "medium" },
  {
    name: "instruction-areas",
    scope: "repository",
    run: "model",
    tier: "medium",
  },
]

export const DISCOVER_ROOTS_SKILL = "discover-roots"

/** The bundle skills of one scope, in run order. An unknown skill is an error. */
export function plannedIngestSkills(
  bundleSkills: readonly string[],
  scope: IngestSkillPlan["scope"],
): IngestSkillPlan[] {
  const known = new Set(INGEST_SKILLS.map((skill) => skill.name))
  const unknown = bundleSkills.filter(
    (name) => name !== DISCOVER_ROOTS_SKILL && !known.has(name),
  )
  if (unknown.length)
    throw new Error(
      `The ingest skill bundle has skills that the plan does not know: ${unknown.join(", ")}`,
    )
  const present = new Set(bundleSkills)
  return INGEST_SKILLS.filter(
    (skill) => skill.scope === scope && present.has(skill.name),
  )
}

/**
 * The workflow step of one skill run:
 * `skill:<label>~<hash>:<skill>[.<page>]:<workspaceId>`. The label is the
 * end of the root path in safe ASCII, for a person who reads the run; the
 * hash of the full root makes the name unique. So the name is always 1 to
 * 200 printable ASCII characters, as the step commit trailer must be.
 * `page` counts the runs of a script skill that said `more: true`.
 */
export function skillStepName(
  root: string,
  skill: string,
  workspaceId: string,
  page = 1,
): string {
  const label = root.replace(/[^A-Za-z0-9._/-]/g, "_").slice(-40)
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12)
  return `skill:${label}~${hash}:${skill}${page > 1 ? `.${page}` : ""}:${workspaceId}`
}
