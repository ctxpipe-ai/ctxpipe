import {
  fetchFiles,
  globFiles,
} from "../../../domain/codeIngestion/codesearchClient.js"
import { isConnectorMirrorPath } from "../../../domain/codeIngestion/connectorMirrorPaths.js"
import { isUnderDependencyVendorPath } from "../../../domain/codeIngestion/dependencyVendorPaths.js"
import { documentDedupKey } from "../../../domain/codeIngestion/referenceResolver.js"
import { getLogger } from "../../../observability/logger.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"
import {
  asString,
  firstParagraph,
  splitFrontmatter,
} from "./connectorFrontmatter.js"
import { linkLocatedPaths } from "./linkLocatedPaths.js"
import {
  filterPathsByPartialScan,
  partialScanPathsForExtractors,
  shouldSkipCodeExtractorForPartialDiff,
} from "./partialIngestionScope.js"

/** Bounds one ingest; the shallowest READMEs (repo root, package roots) are kept first. */
const MAX_README_DOCUMENTS = 2_000

export type ParsedReadme = {
  title: string
  summary: string
  excerpt: string
}

/**
 * Title from the first H1 or frontmatter `title`, else the README's directory;
 * summary is the first prose paragraph. Null for an empty file.
 */
export function parseReadmeMarkdown(
  content: string,
  path: string,
): ParsedReadme | null {
  if (content.trim().length === 0) return null
  const split = splitFrontmatter(content)
  let body = split?.body ?? content

  const headingMatch = /^#\s+(.+?)\s*$/m.exec(body)
  if (headingMatch) {
    body =
      body.slice(0, headingMatch.index) +
      body.slice(headingMatch.index + headingMatch[0].length)
  }
  const excerpt = body.trim().slice(0, 2_000)
  const directory = path.includes("/")
    ? path.slice(0, path.lastIndexOf("/"))
    : path
  const title = headingMatch?.[1] ?? asString(split?.data.title) ?? directory

  return { title, summary: firstParagraph(excerpt), excerpt }
}

/**
 * Every README becomes a `Document` node (ADR-050): title and first paragraph
 * as name and summary, the opening 2,000 characters as the embedded excerpt,
 * and `DECLARED_IN File` → `File PART_OF` its package or the repository via
 * {@link linkLocatedPaths}. Deterministic. Runs once after all roots, so a
 * README outside every package is kept and none is read twice.
 */
export async function extractReadmeDocuments(
  state: CodeIngestionState,
): Promise<{
  extractedObjects: ExtractedObject[]
  extractedClaims: ExtractedClaim[]
}> {
  if (shouldSkipCodeExtractorForPartialDiff(state)) {
    return { extractedObjects: [], extractedClaims: [] }
  }

  const globbed = await globFiles(state.repositoryId, state.orgId, {
    pattern: "**/{README,Readme,readme}.md",
    onlyFiles: true,
  })
  const candidates = globbed.entries
    .filter((entry) => entry.type === "file")
    .map((entry) => entry.path)
    .filter(
      (path) =>
        !isUnderDependencyVendorPath(path) && !isConnectorMirrorPath(path),
    )
  const scoped = (
    state.ingestMode === "partial"
      ? filterPathsByPartialScan(
          candidates,
          partialScanPathsForExtractors(state),
        )
      : candidates
  ).sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  )
  if (scoped.length > MAX_README_DOCUMENTS) {
    getLogger().warn("extractReadmeDocuments: README cap reached", {
      repositoryId: state.repositoryId,
      found: scoped.length,
      kept: MAX_README_DOCUMENTS,
    })
  }
  const paths = scoped.slice(0, MAX_README_DOCUMENTS)
  if (paths.length === 0) return { extractedObjects: [], extractedClaims: [] }

  const contents = await fetchFiles(state.repositoryId, state.orgId, paths)
  const documents: ExtractedObject[] = []
  for (const path of paths) {
    const parsed = parseReadmeMarkdown(contents[path] ?? "", path)
    if (!parsed) continue
    documents.push({
      kind: "Document",
      deduplicationKey: documentDedupKey(state.repositoryId, path),
      name: parsed.title.slice(0, 200),
      summary: parsed.summary,
      payload: { path, excerpt: parsed.excerpt },
    })
  }

  const packages = (state.extractedObjects ?? []).filter(
    (object) =>
      object.kind === "Service" ||
      object.kind === "App" ||
      object.kind === "Library",
  )
  const located = linkLocatedPaths({
    repositoryId: state.repositoryId,
    targetHash: state.targetHash,
    objects: [...packages, ...documents],
    claims: [],
  })
  return {
    extractedObjects: [...documents, ...located.extractedObjects],
    extractedClaims: located.extractedClaims,
  }
}
