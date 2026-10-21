import { createHash } from "node:crypto"
import { gunzipSync, gzipSync } from "node:zlib"
import type { ModelTier } from "../../retrieval/services/providers/providerTypes.js"
import {
  type DiscoveredRoot,
  type RefusedRoot,
  resolveDiscoveredRoots,
} from "./discovered-roots.js"
import type { IngestRootMap } from "./ingest-shard-runtime.js"

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
  /**
   * `first`: one step on the assembled ref before the root steps, which
   * the parent runs in the sandbox of shard 0; `root`:
   * one step for each root; `repository`: one step on the assembled ref
   * after `assemble`.
   */
  scope: "first" | "root" | "repository"
  /** `script`: a plain command; `model`: one OpenCode run. */
  run: "script" | "model"
  tier?: ModelTier
}

/**
 * The skills in their run order (ADR-052 section 6). A skill runs only when
 * the bundle holds it. `discover-roots` is not here: the parent runs it
 * first, and its result plans the root steps. A file that more than one root
 * can write is written only in a repository-wide step. So `dependencies`
 * also runs once on the assembled ref for the Stream files, and
 * `datasources-infra` runs only there: a root step could only link a store
 * file that exists already, and there is none on a first run. Its
 * repository-wide step links every root.
 */
const INGEST_SKILLS: readonly IngestSkillPlan[] = [
  // The repository unit, which every later step can link to.
  { name: "repository", scope: "first", run: "script" },
  { name: "classify-kind", scope: "root", run: "model", tier: "fast" },
  { name: "apis", scope: "root", run: "model", tier: "medium" },
  { name: "dependencies", scope: "root", run: "model", tier: "medium" },
  // `libraries` writes shared files, so it runs on the assembled ref.
  { name: "libraries", scope: "repository", run: "script" },
  { name: "ownership", scope: "repository", run: "script" },
  { name: "dependencies", scope: "repository", run: "model", tier: "medium" },
  {
    name: "datasources-infra",
    scope: "repository",
    run: "model",
    tier: "medium",
  },
  { name: "decisions", scope: "repository", run: "model", tier: "medium" },
  {
    name: "instruction-areas",
    scope: "repository",
    run: "model",
    tier: "medium",
  },
]

const DISCOVER_ROOTS_SKILL = "discover-roots"

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
 * The root part of a root step name: `<label>~<hash>`. The label is the end
 * of the root path in safe ASCII, for a person who reads the run; the hash
 * of the full root makes it unique.
 */
function skillStepRootKey(root: string): string {
  const label = root.replace(/[^A-Za-z0-9._/-]/g, "_").slice(-40)
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12)
  return `${label}~${hash}`
}

/**
 * The workflow step of one skill run:
 * `skill:<root key>:<skill>[.<page>]:<workspaceId>`, and `repository` in
 * place of the root key for a repository-wide skill (`root` null). The name
 * is always 1 to 200 printable ASCII characters, as the step commit trailer
 * must be. `page` counts the runs of a skill whose `patch.json` said `more`.
 */
export function skillStepName(
  root: string | null,
  skill: string,
  workspaceId: string,
  page = 1,
): string {
  const key = root === null ? "repository" : skillStepRootKey(root)
  return `skill:${key}:${skill}${page > 1 ? `.${page}` : ""}:${workspaceId}`
}

/**
 * The `--roots` file of each step: each root of the run and the context
 * files that the root's steps wrote, read from the step commits between the
 * pinned revision and the step base.
 */
export function ingestRootMap(
  roots: readonly DiscoveredRoot[],
  stepFiles: ReadonlyArray<{ step: string; paths: string[] }>,
): IngestRootMap {
  const files = new Map(
    roots.map((r) => [skillStepRootKey(r.path), new Set<string>()]),
  )
  for (const { step, paths } of stepFiles) {
    const found = files.get(step.split(":")[1] ?? "")
    for (const path of found ? paths : []) found?.add(path)
  }
  return {
    roots: roots.map((r) => ({
      path: r.path,
      manifests: r.manifests,
      evidence: r.evidence,
      files: [...(files.get(skillStepRootKey(r.path)) ?? [])].sort(),
    })),
  }
}

type PackedRoot = { path: string; manifests: string[]; evidence: string[] }

/** The root list in the `discover-roots` step output: gzip, then base64. */
export function packRoots(roots: readonly PackedRoot[]): string {
  return gzipSync(
    JSON.stringify(
      roots.map((r) => ({
        path: r.path,
        manifests: r.manifests,
        evidence: r.evidence,
      })),
    ),
  ).toString("base64")
}

/**
 * The root list that `packRoots` packed. `maxBytes` caps the unzipped size:
 * a value over the cap throws, so a corrupt or very large value cannot use
 * all the memory.
 */
export function unpackRoots(packed: string, maxBytes?: number): PackedRoot[] {
  return JSON.parse(
    gunzipSync(
      Buffer.from(packed, "base64"),
      maxBytes ? { maxOutputLength: maxBytes } : {},
    ).toString("utf8"),
  )
}
