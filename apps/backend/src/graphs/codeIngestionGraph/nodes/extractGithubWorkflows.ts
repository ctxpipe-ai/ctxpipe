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
  listPackageRootsForRepository,
  matchPackageForPath,
  type PackageRoot,
  packageRootsFromObjects,
} from "./linkLocatedPaths.js"
import { shouldSkipCodeExtractorForPartialDiff } from "./partialIngestionScope.js"

type ParsedWorkflow = {
  name: string
  triggers: string[]
  jobs: string[]
  /** `on.<event>.paths` filters and `working-directory` values, as written. */
  locations: string[]
}

/** Returns null when the file is not a YAML map with jobs. */
function parseGithubWorkflow(
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
    name: asString(doc.name) ?? path.slice(path.lastIndexOf("/") + 1),
    triggers,
    jobs: Object.keys(jobs),
    locations,
  }
}

/**
 * Source-repository extractor for GitHub Actions workflow files: `Workflow`
 * nodes with `DECLARED_IN File` (via the link pass) and
 * `Workflow MENTIONS Service|App|Library` for the package a path filter or
 * working directory falls in. The workspace root is never mentioned: every
 * workflow lives in it. Deterministic.
 *
 * Every ingest reads every workflow and matches against the repository's
 * packages on the graph as well as this run's: a partial ingest runs only the
 * changed roots, after retraction removed the edited workflow's edges.
 */
export async function extractGithubWorkflows(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  if (shouldSkipCodeExtractorForPartialDiff(state)) return {}

  // GitHub runs workflows from the repository root only.
  const globbed = await Promise.all(
    [".github/workflows/*.yml", ".github/workflows/*.yaml"].map((pattern) =>
      globFiles(state.repositoryId, state.orgId, { pattern, onlyFiles: true }),
    ),
  )
  const paths = [
    ...new Set(
      globbed.flatMap((result) =>
        result.entries
          .filter((entry) => entry.type === "file")
          .map((entry) => entry.path.replace(/^\.\//, "")),
      ),
    ),
  ].sort()
  if (paths.length === 0) return {}

  const contents = await fetchFiles(state.repositoryId, state.orgId, paths)
  const packages = [
    ...packageRootsFromObjects(state.extractedObjects ?? []),
    ...(await listPackageRootsForRepository({
      orgId: state.orgId,
      repositoryId: state.repositoryId,
    })),
  ].filter(
    (entry) => entry.repositoryId === state.repositoryId && entry.root !== "./",
  )

  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []
  for (const path of paths) {
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
      payload: { path },
    })

    const mentioned = new Map<string, PackageRoot>()
    for (const location of parsed.locations) {
      const located = asLocatedPath(location)
      const pkg = located ? matchPackageForPath(located, packages) : null
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
