import { buildEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import {
  extractUrls,
  findLinearIdentifiers,
  isoDateOf,
  issueDedupKey,
  parseLinearIssueUrl,
  pullRequestDedupKey,
} from "../../../domain/codeIngestion/referenceResolver.js"
import {
  asLocatedPath,
  fileDedupKey,
  matchPackageForPath,
  type PackageRoot,
} from "../../../graphs/codeIngestionGraph/nodes/linkLocatedPaths.js"
import type {
  ExtractedClaim,
  ExtractedObject,
} from "../../../graphs/codeIngestionGraph/schemas.js"
import type { ParsedGithubPullRequest } from "./converter.js"
import type { GithubPrFileStatus } from "./types.js"

export function githubPrFileChangePredicate(
  status: GithubPrFileStatus,
): "ADDED" | "MODIFIED" | "REMOVED" | "RENAMED" {
  switch (status) {
    case "added":
    case "copied":
      return "ADDED"
    case "removed":
      return "REMOVED"
    case "renamed":
      return "RENAMED"
    default:
      return "MODIFIED"
  }
}

export function githubPullRequestDedupKey(input: {
  sourceRepositoryId?: string
  repository: string
  number: number
}): string {
  return pullRequestDedupKey(input)
}

export function githubFileDedupKey(input: {
  sourceRepositoryId?: string
  repository: string
  path: string
}): string {
  const scope = input.sourceRepositoryId ?? `github:${input.repository}`
  const path = asLocatedPath(input.path) ?? input.path.replace(/\\/g, "/")
  return fileDedupKey(scope, path)
}

/** Linear identifiers referenced by a pull request: URLs anywhere, bare ids in title / body / branch. */
export function linearIssueIdentifiersForPullRequest(
  parsed: Pick<ParsedGithubPullRequest, "title" | "bodyExcerpt" | "head">,
  linearTeamKeys: ReadonlyArray<string>,
): string[] {
  const text = `${parsed.title}\n${parsed.head.ref}\n${parsed.bodyExcerpt}`
  const found = new Set<string>()
  for (const url of extractUrls(text)) {
    const identifier = parseLinearIssueUrl(url)
    if (identifier) found.add(identifier)
  }
  for (const identifier of findLinearIdentifiers(text, linearTeamKeys)) {
    found.add(identifier)
  }
  return [...found]
}

/**
 * Deterministic graph for one mirrored pull request (ADR-031, ADR-033):
 * `PullRequest TARGETS Repository`, `PullRequest ADDED|MODIFIED|REMOVED|RENAMED File`,
 * `File PART_OF Repository|package` for paths still present, and
 * `PullRequest REFERENCES Issue` for Linear identifiers in the PR text.
 * Change edges carry `validFrom` = merge date.
 */
export function buildGithubPullRequestGraph(input: {
  parsed: ParsedGithubPullRequest
  markdownPath: string
  targetHash: string
  /** Repository that holds the mirrored Markdown (evidence owner). */
  contextRepositoryId: string
  sourceRepositoryId?: string
  packageRoots?: PackageRoot[]
  linearTeamKeys?: ReadonlyArray<string>
}): {
  extractedObjects: ExtractedObject[]
  extractedClaims: ExtractedClaim[]
} {
  const { parsed } = input
  const sourceScope = input.sourceRepositoryId ?? "unresolved"
  const mergedOn = isoDateOf(parsed.mergedAt)
  const pullKey = githubPullRequestDedupKey({
    sourceRepositoryId: input.sourceRepositoryId,
    repository: parsed.repository,
    number: parsed.number,
  })
  const sourceId = (segments: string[]) =>
    buildEvidenceSourceId({
      extractor: "githubPull",
      repositoryId: input.contextRepositoryId,
      segments: [sourceScope, input.markdownPath, ...segments],
      targetHash: input.targetHash,
    })

  const objects: ExtractedObject[] = [
    {
      kind: "PullRequest",
      deduplicationKey: pullKey,
      name: `${parsed.repository}#${parsed.number}`,
      summary: parsed.title.slice(0, 500),
      payload: {
        number: parsed.number,
        repository: parsed.repository,
        url: parsed.url,
        state: parsed.state,
        merged: parsed.merged,
        merged_at: parsed.mergedAt,
        review_decision: parsed.reviewDecision,
        author: parsed.author.login,
        excerpt: parsed.bodyExcerpt,
      },
    },
  ]
  const claims: ExtractedClaim[] = []

  if (input.sourceRepositoryId) {
    claims.push({
      subjectRef: pullKey,
      subjectKind: "PullRequest",
      objectRef: input.sourceRepositoryId,
      objectKind: "Repository",
      predicate: "TARGETS",
      sourceId: sourceId(["TARGETS"]),
      sourceType: "git",
      extractionMethod: "deterministic",
      confidence: 0.95,
      provenance: { path: input.markdownPath },
      ...(mergedOn ? { validFrom: mergedOn } : {}),
    })
  }

  const packages = (input.packageRoots ?? []).filter(
    (entry) => entry.repositoryId === input.sourceRepositoryId,
  )

  for (const file of parsed.files) {
    const path = asLocatedPath(file.path) ?? file.path.replace(/\\/g, "/")
    const fileKey = githubFileDedupKey({
      sourceRepositoryId: input.sourceRepositoryId,
      repository: parsed.repository,
      path,
    })
    objects.push({
      kind: "File",
      deduplicationKey: fileKey,
      name: path,
      summary: `File at ${path}`,
      payload: { path, repository: parsed.repository },
    })

    if (input.sourceRepositoryId && file.status !== "removed") {
      claims.push({
        subjectRef: fileKey,
        subjectKind: "File",
        objectRef: input.sourceRepositoryId,
        objectKind: "Repository",
        predicate: "PART_OF",
        sourceId: sourceId(["PART_OF", "repository", path]),
        sourceType: "git",
        extractionMethod: "deterministic",
        confidence: 0.95,
        provenance: { path: input.markdownPath, file: path },
      })
      const pkg = matchPackageForPath(path, packages)
      if (pkg) {
        claims.push({
          subjectRef: fileKey,
          subjectKind: "File",
          objectRef: pkg.deduplicationKey,
          objectKind: pkg.kind,
          predicate: "PART_OF",
          sourceId: sourceId(["PART_OF", "package", path, pkg.root]),
          sourceType: "git",
          extractionMethod: "deterministic",
          confidence: 0.95,
          provenance: { path: input.markdownPath, file: path, root: pkg.root },
        })
      }
    }

    const predicate = githubPrFileChangePredicate(file.status)
    claims.push({
      subjectRef: pullKey,
      subjectKind: "PullRequest",
      objectRef: fileKey,
      objectKind: "File",
      predicate,
      sourceId: sourceId([predicate, path]),
      sourceType: "git",
      extractionMethod: "deterministic",
      confidence: 0.95,
      provenance: {
        path: input.markdownPath,
        file: path,
        previousPath: file.previousPath,
        status: file.status,
      },
      ...(mergedOn ? { validFrom: mergedOn } : {}),
    })
  }

  for (const identifier of linearIssueIdentifiersForPullRequest(
    parsed,
    input.linearTeamKeys ?? [],
  )) {
    claims.push({
      subjectRef: pullKey,
      subjectKind: "PullRequest",
      objectRef: issueDedupKey(identifier),
      objectKind: "Issue",
      predicate: "REFERENCES",
      sourceId: sourceId(["REFERENCES", identifier]),
      sourceType: "git",
      extractionMethod: "deterministic",
      confidence: 0.9,
      provenance: { path: input.markdownPath, identifier },
    })
  }

  return { extractedObjects: objects, extractedClaims: claims }
}
