import {
  fetchFiles,
  globFiles,
} from "../../../domain/codeIngestion/codesearchClient.js"
import { buildEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import {
  githubIssueDedupKey,
  parseGithubPullRequestUrl,
  pullRequestDedupKey,
} from "../../../domain/codeIngestion/referenceResolver.js"
import {
  GITHUB_ISSUES_PREFIX,
  type ParsedGithubIssue,
  parseGithubIssueMarkdown,
} from "../../../services/github/issue-mirror/converter.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"
import {
  filterPathsByPartialScan,
  partialScanPathsForExtractors,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"
import {
  type RepositoryIdCache,
  resolveSourceRepositoryId,
} from "./repositoryResolution.js"

/**
 * `Issue`, `Issue PART_OF Repository`, and `Issue REFERENCES PullRequest` for
 * each pull request GitHub links as closing it.
 */
export function buildGithubIssueGraph(input: {
  parsed: ParsedGithubIssue
  markdownPath: string
  targetHash: string
  /** Repository that holds the mirrored Markdown (evidence owner). */
  contextRepositoryId: string
  sourceRepositoryId: string
  /** Closing pull requests, keyed by `pullRequestDedupKey`. */
  closedBy?: ReadonlyArray<{ key: string; url: string; ref: string }>
}): { extractedObjects: ExtractedObject[]; extractedClaims: ExtractedClaim[] } {
  const { parsed } = input
  const identifier = `${parsed.repository}#${parsed.number}`
  const issueKey = githubIssueDedupKey(input.sourceRepositoryId, parsed.number)
  const issue: ExtractedObject = {
    kind: "Issue",
    deduplicationKey: issueKey,
    name: `${identifier}: ${parsed.title}`.slice(0, 200),
    summary: parsed.title.slice(0, 500),
    payload: {
      identifier,
      title: parsed.title,
      url: parsed.url,
      state: parsed.state,
      state_reason: parsed.stateReason,
      author: parsed.author,
      labels: parsed.labels,
      assignees: parsed.assignees,
      created_at: parsed.createdAt,
      updated_at: parsed.updatedAt,
      closed_at: parsed.closedAt,
      excerpt: parsed.excerpt,
    },
  }
  const sourceId = (segments: string[]) =>
    buildEvidenceSourceId({
      extractor: "githubIssue",
      repositoryId: input.contextRepositoryId,
      segments: [input.sourceRepositoryId, input.markdownPath, ...segments],
      targetHash: input.targetHash,
    })
  return {
    extractedObjects: [issue],
    extractedClaims: [
      {
        subjectRef: issueKey,
        subjectKind: "Issue",
        objectRef: input.sourceRepositoryId,
        objectKind: "Repository",
        predicate: "PART_OF",
        sourceId: sourceId(["PART_OF"]),
        sourceType: "git",
        extractionMethod: "deterministic",
        confidence: 0.95,
        provenance: { path: input.markdownPath },
      },
      ...(input.closedBy ?? []).map(
        (pull): ExtractedClaim => ({
          subjectRef: issueKey,
          subjectKind: "Issue",
          objectRef: pull.key,
          objectKind: "PullRequest",
          predicate: "REFERENCES",
          sourceId: sourceId(["REFERENCES", pull.ref]),
          sourceType: "git",
          extractionMethod: "deterministic",
          confidence: 0.95,
          provenance: { path: input.markdownPath, url: pull.url },
        }),
      ),
    ],
  }
}

/**
 * Connector extractor for `github/issues/**`. Deterministic: parses the
 * mirrored frontmatter and resolves the source repository on the same GitHub
 * connection. An issue of a repository that is not connected is skipped.
 */
export async function extractGithubIssues(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  if (shouldSkipExtractorForPartialDeletesOnly(state)) return {}

  const scanPaths = partialScanPathsForExtractors(state)
  const globbed = await globFiles(state.repositoryId, state.orgId, {
    pattern: `${GITHUB_ISSUES_PREFIX}**/*.md`,
    onlyFiles: true,
  })
  const paths = globbed.entries
    .filter((entry) => entry.type === "file")
    .map((entry) => entry.path)
  const scopedPaths =
    state.ingestMode === "partial" && scanPaths.length > 0
      ? filterPathsByPartialScan(paths, scanPaths)
      : paths
  if (scopedPaths.length === 0) return {}

  const contents = await fetchFiles(
    state.repositoryId,
    state.orgId,
    scopedPaths,
  )
  const extractedObjects: ExtractedObject[] = []
  const extractedClaims: ExtractedClaim[] = []
  const repositoryIds: RepositoryIdCache = new Map()
  for (const path of scopedPaths) {
    const content = contents[path]
    const parsed = content ? parseGithubIssueMarkdown(content) : null
    if (!parsed) continue
    const sourceRepositoryId = await resolveSourceRepositoryId({
      orgId: state.orgId,
      repository: parsed.repository,
      githubConnectionId: state.githubConnectionId,
      cache: repositoryIds,
    })
    if (!sourceRepositoryId) continue
    const closedBy = []
    for (const url of parsed.closedBy) {
      const pull = parseGithubPullRequestUrl(url)
      if (!pull) continue
      const pullRepositoryId = await resolveSourceRepositoryId({
        orgId: state.orgId,
        repository: pull.repository,
        githubConnectionId: state.githubConnectionId,
        cache: repositoryIds,
      })
      closedBy.push({
        key: pullRequestDedupKey({
          sourceRepositoryId: pullRepositoryId,
          repository: pull.repository,
          number: pull.number,
        }),
        url,
        ref: `${pull.repository}#${pull.number}`,
      })
    }
    const graph = buildGithubIssueGraph({
      parsed,
      markdownPath: path,
      targetHash: state.targetHash,
      contextRepositoryId: state.repositoryId,
      sourceRepositoryId,
      closedBy,
    })
    extractedObjects.push(...graph.extractedObjects)
    extractedClaims.push(...graph.extractedClaims)
  }
  return { extractedObjects, extractedClaims }
}
