import {
  fetchFiles,
  globFiles,
} from "../../../domain/codeIngestion/codesearchClient.js"
import {
  GITHUB_PR_PULLS_PREFIX,
  parseGithubPullRequestMarkdown,
} from "../../../services/github/pull-request-mirror/converter.js"
import { buildGithubPullRequestGraph } from "../../../services/github/pull-request-mirror/graph.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"
import {
  listLinearTeamKeys,
  listPackageRootsForRepository,
  type PackageRoot,
} from "./linkLocatedPaths.js"
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
 * Connector extractor for `github/pulls/**` (ADR-031). Deterministic: parses
 * the mirrored frontmatter, resolves the source repository on the same GitHub
 * connection, and emits PullRequest / File objects with change edges.
 */
export async function extractGithubPullRequests(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  if (shouldSkipExtractorForPartialDeletesOnly(state)) {
    return {}
  }

  const scanPaths = partialScanPathsForExtractors(state)
  const globbed = await globFiles(state.repositoryId, state.orgId, {
    pattern: `${GITHUB_PR_PULLS_PREFIX}**/*.md`,
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

  const [contents, linearTeamKeys] = await Promise.all([
    fetchFiles(state.repositoryId, state.orgId, scopedPaths),
    listLinearTeamKeys(state.orgId),
  ])
  const extractedObjects: ExtractedObject[] = []
  const extractedClaims: ExtractedClaim[] = []
  const repositoryIds: RepositoryIdCache = new Map()
  const packageRootsByRepo = new Map<string, PackageRoot[]>()

  for (const path of scopedPaths) {
    const content = contents[path]
    if (!content) continue
    const parsed = parseGithubPullRequestMarkdown(content)
    if (!parsed) continue
    const sourceRepositoryId = await resolveSourceRepositoryId({
      orgId: state.orgId,
      repository: parsed.repository,
      githubConnectionId: state.githubConnectionId,
      cache: repositoryIds,
    })
    let packageRoots: PackageRoot[] = []
    if (sourceRepositoryId) {
      const cached = packageRootsByRepo.get(sourceRepositoryId)
      if (cached) {
        packageRoots = cached
      } else {
        packageRoots = await listPackageRootsForRepository({
          orgId: state.orgId,
          repositoryId: sourceRepositoryId,
        })
        packageRootsByRepo.set(sourceRepositoryId, packageRoots)
      }
    }
    const graph = buildGithubPullRequestGraph({
      parsed,
      markdownPath: path,
      targetHash: state.targetHash,
      contextRepositoryId: state.repositoryId,
      sourceRepositoryId,
      packageRoots,
      linearTeamKeys,
    })
    extractedObjects.push(...graph.extractedObjects)
    extractedClaims.push(...graph.extractedClaims)
  }

  return { extractedObjects, extractedClaims }
}
