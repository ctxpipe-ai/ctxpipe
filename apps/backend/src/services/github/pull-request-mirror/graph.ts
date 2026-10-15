import { buildEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import {
  asLocatedPath,
  extractUrls,
  fileDedupKey,
  findLinearIdentifiers,
  isoDateOf,
  issueDedupKey,
  parseLinearIssueUrl,
  pullRequestDedupKey,
} from "../../../domain/codeIngestion/referenceResolver.js"
import {
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
  parsed: Pick<ParsedGithubPullRequest, "title" | "body" | "head">,
  linearTeamKeys: ReadonlyArray<string>,
): string[] {
  const text = `${parsed.title}\n${parsed.head.ref}\n${parsed.body}`
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
 * Linear identifiers a merged pull request closes: each id in the head branch
 * name, and each id or Linear issue URL directly after a closing keyword in
 * the title or body. A revert pull request closes nothing.
 */
export function linearIssueIdentifiersResolvedByPullRequest(
  parsed: Pick<ParsedGithubPullRequest, "title" | "body" | "head">,
  linearTeamKeys: ReadonlyArray<string>,
): string[] {
  if (
    parsed.head.ref.startsWith("revert-") ||
    parsed.title.startsWith('Revert "')
  )
    return []
  // Linear's closing keywords and their forms, an optional colon, then the next
  // word, which can open a Markdown link or code span: `Fixes [ENG-1](…)`.
  const closingKeyword =
    /\b(?:clos(?:e|es|ed|ing)|fix(?:es|ed|ing)?|resolv(?:e|es|ed|ing)|complet(?:e|es|ed|ing))(?::\s*|\s+)[[`]?(\S+)/gi
  const found = new Set(findLinearIdentifiers(parsed.head.ref, linearTeamKeys))
  for (const match of `${parsed.title}\n${parsed.body}`.matchAll(
    closingKeyword,
  )) {
    const word =
      (match[1] ?? "").split(/[\]`]/)[0]?.replace(/[.,;:!?)]+$/, "") ?? ""
    const leading = /^[A-Za-z][A-Za-z0-9]*-\d+/.exec(word)?.[0] ?? ""
    const identifier =
      parseLinearIssueUrl(word) ??
      findLinearIdentifiers(leading, linearTeamKeys)[0]
    if (identifier) found.add(identifier)
  }
  return [...found]
}

/**
 * Deterministic graph for one mirrored pull request (ADR-031, ADR-033):
 * `PullRequest TARGETS Repository`, `PullRequest ADDED|MODIFIED|REMOVED|RENAMED File`,
 * `File PART_OF Repository|package` for paths still present, and
 * `PullRequest REFERENCES Issue` for Linear identifiers in the PR text, or
 * `PullRequest RESOLVES Issue` when the merged PR closes that issue.
 * Change edges carry `validFrom` = merge date. A pull request closed without
 * a merge keeps only its node, `TARGETS`, and `REFERENCES`.
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
  const pullKey = pullRequestDedupKey({
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

  // A pull request closed without a merge changed nothing on the base branch.
  for (const file of parsed.merged ? parsed.files : []) {
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

  const resolved = new Set(
    parsed.merged
      ? linearIssueIdentifiersResolvedByPullRequest(
          parsed,
          input.linearTeamKeys ?? [],
        )
      : [],
  )
  for (const identifier of linearIssueIdentifiersForPullRequest(
    parsed,
    input.linearTeamKeys ?? [],
  )) {
    const predicate = resolved.has(identifier) ? "RESOLVES" : "REFERENCES"
    claims.push({
      subjectRef: pullKey,
      subjectKind: "PullRequest",
      objectRef: issueDedupKey(identifier),
      objectKind: "Issue",
      predicate,
      sourceId: sourceId([predicate, identifier]),
      sourceType: "git",
      extractionMethod: "deterministic",
      confidence: 0.9,
      provenance: { path: input.markdownPath, identifier },
      ...(predicate === "RESOLVES" && mergedOn ? { validFrom: mergedOn } : {}),
    })
  }

  return { extractedObjects: objects, extractedClaims: claims }
}
