import { posix } from "node:path"
import type { ModelTier } from "../../retrieval/services/providers/providerTypes.js"

/*
 * The plan of an ingestion v2 run (ADR-052, concept section 2): how the
 * parent splits the source roots into shards, and which skill steps a shard
 * runs. The plan is a function of the source SHA and the skill bundle, so a
 * replayed run makes the same steps.
 */

/** One shard takes at most this many roots (concept section 8). */
export const INGEST_SHARD_MAX_ROOTS = 20

/** Manifest files that make a folder a candidate root. */
const ROOT_MANIFESTS = new Set([
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
])

/**
 * The candidate roots of the source at the run's SHA: each folder with a
 * manifest. The parent uses the count only, to size the shards. The
 * `discover-roots` skill in each shard finds the real roots.
 */
export function sourceCandidateRoots(paths: readonly string[]): string[] {
  const roots = new Set<string>()
  for (const path of paths)
    if (ROOT_MANIFESTS.has(posix.basename(path))) roots.add(posix.dirname(path))
  return [...roots].sort()
}

export function ingestShardCount(roots: number): number {
  return Math.max(1, Math.ceil(roots / INGEST_SHARD_MAX_ROOTS))
}

/**
 * The roots of one shard: each `shards`-th root of the sorted discovery
 * result. Each root goes to exactly one shard, also when discovery finds
 * more roots than the plan counted.
 */
export function shardRoots(
  roots: readonly string[],
  shard: number,
  shards: number,
): string[] {
  return [...roots].sort().filter((_, i) => i % shards === shard)
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
  { name: "libraries", scope: "root", run: "script" },
  { name: "classify-kind", scope: "root", run: "model", tier: "fast" },
  { name: "apis", scope: "root", run: "model", tier: "medium" },
  { name: "dependencies", scope: "root", run: "model", tier: "medium" },
  { name: "datasources-infra", scope: "root", run: "model", tier: "medium" },
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

/** The workflow step of one skill run: `skill:<root>:<skill>:<workspaceId>`. */
export function skillStepName(
  root: string,
  skill: string,
  workspaceId: string,
): string {
  return `skill:${root}:${skill}:${workspaceId}`
}
