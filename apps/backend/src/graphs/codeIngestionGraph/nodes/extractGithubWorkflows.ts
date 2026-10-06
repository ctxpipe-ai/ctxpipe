import { parse as parseYaml } from "yaml"
import {
  fetchFiles,
  globFiles,
} from "../../../domain/codeIngestion/codesearchClient.js"
import { buildEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import {
  asLocatedPath,
  workflowDedupKey,
} from "../../../domain/codeIngestion/referenceResolver.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"
import { asRecord, asString, asStringArray } from "./connectorFrontmatter.js"
import {
  matchPackageForPath,
  packageRootsFromObjects,
} from "./linkLocatedPaths.js"
import {
  filterPathsByPartialScan,
  partialScanPathsForExtractors,
  shouldSkipCodeExtractorForPartialDiff,
} from "./partialIngestionScope.js"

/** GitHub runs workflows from the repository root only. */
export const WORKFLOW_GLOBS = [
  ".github/workflows/*.yml",
  ".github/workflows/*.yaml",
] as const

export type ParsedWorkflow = {
  name: string
  triggers: string[]
  jobs: string[]
  /** `on.<event>.paths` filters and `working-directory` values, as written. */
  locations: string[]
}

/** Returns null when the file is not a YAML map with jobs. */
export function parseGithubWorkflow(
  content: string,
  path: string,
): ParsedWorkflow | null {
  let doc: Record<string, unknown> | null
  try {
    doc = asRecord(parseYaml(content))
  } catch {
    return null
  }
  const jobs = asRecord(doc?.jobs)
  if (!doc || !jobs) return null

  const on = doc.on
  const onMap = asRecord(on)
  const triggers =
    typeof on === "string"
      ? [on]
      : onMap
        ? Object.keys(onMap)
        : asStringArray(on)

  const workingDirectory = (value: unknown) =>
    asString(asRecord(asRecord(value)?.run)?.["working-directory"])
  const locations = [
    ...Object.values(onMap ?? {}).flatMap((event) =>
      asStringArray(asRecord(event)?.paths),
    ),
    workingDirectory(doc.defaults),
    ...Object.values(jobs).flatMap((value) => {
      const job = asRecord(value)
      const steps: unknown[] = Array.isArray(job?.steps) ? job.steps : []
      return [
        workingDirectory(job?.defaults),
        ...steps.map((step) => asString(asRecord(step)?.["working-directory"])),
      ]
    }),
  ].filter((value): value is string => value !== null)

  return {
    name: asString(doc.name) ?? path.split("/").pop() ?? path,
    triggers,
    jobs: Object.keys(jobs),
    locations,
  }
}

/**
 * The directory a path filter or working directory names, up to its first
 * glob segment. Null for negations, expressions and the repository root.
 */
export function workflowLocationPrefix(value: string): string | null {
  if (value.startsWith("!") || value.includes("${{")) return null
  const segments: string[] = []
  for (const segment of value.split("/")) {
    if (/[*?[{]/.test(segment)) break
    segments.push(segment)
  }
  return asLocatedPath(segments.join("/"))
}

/**
 * Source-repository extractor for GitHub Actions workflow files: `Workflow`
 * nodes with `DECLARED_IN File` (via the link pass) and
 * `Workflow MENTIONS Service|App|Library` for each package a path filter or
 * working directory names. The workspace root is never mentioned: every
 * workflow lives in it. Deterministic.
 */
export async function extractGithubWorkflows(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  if (shouldSkipCodeExtractorForPartialDiff(state)) return {}

  const globbed = await Promise.all(
    WORKFLOW_GLOBS.map((pattern) =>
      globFiles(state.repositoryId, state.orgId, { pattern, onlyFiles: true }),
    ),
  )
  const candidates = [
    ...new Set(
      globbed.flatMap((result) =>
        result.entries
          .filter((entry) => entry.type === "file")
          .map((entry) => entry.path.replace(/^\.\//, "")),
      ),
    ),
  ].sort()
  const scanPaths = partialScanPathsForExtractors(state)
  const scopedPaths =
    state.ingestMode === "partial" && scanPaths.length > 0
      ? filterPathsByPartialScan(candidates, scanPaths)
      : candidates
  if (scopedPaths.length === 0) return {}

  const contents = await fetchFiles(
    state.repositoryId,
    state.orgId,
    scopedPaths,
  )
  const packages = packageRootsFromObjects(state.extractedObjects ?? []).filter(
    (entry) => entry.repositoryId === state.repositoryId && entry.root !== "./",
  )

  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []
  for (const path of scopedPaths) {
    const content = contents[path]
    if (!content) continue
    const parsed = parseGithubWorkflow(content, path)
    if (!parsed) continue
    const key = workflowDedupKey(state.repositoryId, path)
    const triggers =
      parsed.triggers.length > 0 ? ` on ${parsed.triggers.join(", ")}` : ""
    objects.push({
      kind: "Workflow",
      deduplicationKey: key,
      name: parsed.name.slice(0, 200),
      summary:
        `GitHub Actions workflow${triggers}; jobs: ${parsed.jobs.join(", ")}`.slice(
          0,
          500,
        ),
      payload: { path, triggers: parsed.triggers, jobs: parsed.jobs },
    })

    const mentioned = new Map<string, (typeof packages)[number]>()
    for (const location of parsed.locations) {
      const prefix = workflowLocationPrefix(location)
      const pkg = prefix ? matchPackageForPath(prefix, packages) : null
      if (pkg) mentioned.set(pkg.deduplicationKey, pkg)
    }
    for (const pkg of mentioned.values()) {
      claims.push({
        subjectRef: key,
        subjectKind: "Workflow",
        objectRef: pkg.deduplicationKey,
        objectKind: pkg.kind,
        predicate: "MENTIONS",
        sourceId: buildEvidenceSourceId({
          extractor: "workflow",
          repositoryId: state.repositoryId,
          segments: [path, "MENTIONS", pkg.root],
          targetHash: state.targetHash,
        }),
        sourceType: "git",
        extractionMethod: "deterministic",
        confidence: 0.8,
        provenance: { path, root: pkg.root },
      })
    }
  }

  return { extractedObjects: objects, extractedClaims: claims }
}
