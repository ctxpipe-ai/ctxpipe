import {
  fetchFiles,
  globFiles,
} from "../../../domain/codeIngestion/codesearchClient.js"
import { buildEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import {
  issueDedupKey,
  linearTeamDedupKey,
  normalizeLinearIdentifier,
  parseGithubPullRequestUrl,
  pullRequestDedupKey,
} from "../../../domain/codeIngestion/referenceResolver.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"
import {
  asRecord,
  asString,
  asStringArray,
  excerptOf,
  firstParagraph,
  splitFrontmatter,
} from "./connectorFrontmatter.js"
import {
  filterPathsByPartialScan,
  partialScanPathsForExtractors,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"
import {
  type RepositoryIdCache,
  resolveSourceRepositoryId,
} from "./repositoryResolution.js"

export const LINEAR_ISSUES_GLOB = "linear/issues/**/*.md"
export const LINEAR_TEAMS_GLOB = "linear/teams/**/*.md"

const TEAM_KEY = /^[A-Za-z][A-Za-z0-9]{0,9}$/

export type ParsedLinearIssue = {
  id: string | null
  identifier: string
  title: string
  url: string | null
  state: string | null
  priority: string | null
  team: string | null
  teamKey: string | null
  project: string | null
  labels: string[]
  createdAt: string | null
  updatedAt: string | null
  githubPullRequests: Array<{ url: string; state: string | null }>
  excerpt: string
}

/** Frontmatter written by `renderLinearIssue` (services/linear/converter.ts). */
export function parseLinearIssueMarkdown(
  content: string,
): ParsedLinearIssue | null {
  const split = splitFrontmatter(content)
  if (!split) return null
  const { data, body } = split
  if (data.source !== "linear" || data.type !== "issue") return null
  const rawIdentifier = asString(data.identifier)
  const identifier = rawIdentifier
    ? normalizeLinearIdentifier(rawIdentifier)
    : null
  const title = asString(data.title)
  if (!identifier || !title) return null
  const rawTeamKey = asString(data.teamKey)
  const teamKey =
    rawTeamKey && TEAM_KEY.test(rawTeamKey) ? rawTeamKey.toUpperCase() : null
  const githubPullRequests = Array.isArray(data.githubReferences)
    ? data.githubReferences.flatMap((entry) => {
        const row = asRecord(entry)
        const url = row ? asString(row.url) : null
        return row?.kind === "pull_request" && url
          ? [{ url, state: asString(row.state) }]
          : []
      })
    : []
  return {
    id: asString(data.id),
    identifier,
    title,
    url: asString(data.url),
    state: asString(data.state),
    priority: asString(data.priority),
    team: asString(data.team),
    teamKey,
    project: asString(data.project),
    labels: asStringArray(data.labels),
    createdAt: asString(data.createdAt),
    updatedAt: asString(data.updatedAt),
    githubPullRequests,
    excerpt: excerptOf(body, /\n## Comments\b/),
  }
}

export type ParsedLinearTeam = {
  id: string | null
  key: string
  title: string
  url: string | null
  summary: string
}

/** Frontmatter written by `renderLinearEntity` for `linear/teams/`. */
export function parseLinearTeamMarkdown(
  content: string,
): ParsedLinearTeam | null {
  const split = splitFrontmatter(content)
  if (!split) return null
  const { data, body } = split
  if (data.source !== "linear" || data.type !== "team") return null
  const key = asString(data.key)
  const title = asString(data.title)
  if (!key || !TEAM_KEY.test(key) || !title) return null
  return {
    id: asString(data.id),
    key: key.toUpperCase(),
    title,
    url: asString(data.url),
    summary: firstParagraph(excerptOf(body, null)),
  }
}

function teamObject(input: {
  key: string
  name: string
  url?: string | null
  linearId?: string | null
  summary?: string
}): ExtractedObject {
  return {
    kind: "Team",
    deduplicationKey: linearTeamDedupKey(input.key),
    name: input.name.slice(0, 200),
    ...(input.summary ? { summary: input.summary.slice(0, 500) } : {}),
    payload: {
      key: input.key,
      source: "linear",
      ...(input.url ? { url: input.url } : {}),
      ...(input.linearId ? { linear_id: input.linearId } : {}),
    },
  }
}

function filePaths(globbed: {
  entries: Array<{ type: string; path: string }>
}) {
  return globbed.entries
    .filter((entry) => entry.type === "file")
    .map((entry) => entry.path)
}

/**
 * Connector extractor for `linear/` (ADR-033): `Issue` and `Team` nodes,
 * `Team OWNS Issue`, and `Issue REFERENCES PullRequest` from the GitHub
 * attachment URLs Linear already records. Deterministic; no LLM.
 */
export async function extractLinear(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  if (shouldSkipExtractorForPartialDeletesOnly(state)) return {}

  const scanPaths = partialScanPathsForExtractors(state)
  const [issueGlob, teamGlob] = await Promise.all([
    globFiles(state.repositoryId, state.orgId, {
      pattern: LINEAR_ISSUES_GLOB,
      onlyFiles: true,
    }),
    globFiles(state.repositoryId, state.orgId, {
      pattern: LINEAR_TEAMS_GLOB,
      onlyFiles: true,
    }),
  ])
  const partial = state.ingestMode === "partial" && scanPaths.length > 0
  const issuePaths = partial
    ? filterPathsByPartialScan(filePaths(issueGlob), scanPaths)
    : filePaths(issueGlob)
  const teamPaths = filePaths(teamGlob)
  const changedTeamPaths = partial
    ? filterPathsByPartialScan(teamPaths, scanPaths)
    : teamPaths
  if (issuePaths.length === 0 && changedTeamPaths.length === 0) return {}

  const contents = await fetchFiles(state.repositoryId, state.orgId, [
    ...teamPaths,
    ...issuePaths,
  ])

  const teams = new Map<string, ExtractedObject>()
  for (const path of teamPaths) {
    const content = contents[path]
    if (!content) continue
    const parsed = parseLinearTeamMarkdown(content)
    if (!parsed) continue
    teams.set(
      parsed.key,
      teamObject({
        key: parsed.key,
        name: parsed.title,
        url: parsed.url,
        linearId: parsed.id,
        summary: parsed.summary,
      }),
    )
  }

  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []
  const repositoryIds: RepositoryIdCache = new Map()
  const sourceId = (path: string, predicate: string, target: string) =>
    buildEvidenceSourceId({
      extractor: "linearIssue",
      repositoryId: state.repositoryId,
      segments: [path, predicate, target],
      targetHash: state.targetHash,
    })

  for (const path of issuePaths) {
    const content = contents[path]
    if (!content) continue
    const parsed = parseLinearIssueMarkdown(content)
    if (!parsed) continue
    const issueKey = issueDedupKey(parsed.identifier)
    objects.push({
      kind: "Issue",
      deduplicationKey: issueKey,
      name: `${parsed.identifier}: ${parsed.title}`.slice(0, 200),
      summary: parsed.title.slice(0, 500),
      payload: {
        identifier: parsed.identifier,
        title: parsed.title,
        url: parsed.url,
        state: parsed.state,
        priority: parsed.priority,
        team: parsed.team,
        team_key: parsed.teamKey,
        project: parsed.project,
        labels: parsed.labels,
        created_at: parsed.createdAt,
        updated_at: parsed.updatedAt,
        linear_id: parsed.id,
        excerpt: parsed.excerpt,
      },
    })

    if (parsed.teamKey) {
      if (!teams.has(parsed.teamKey)) {
        teams.set(
          parsed.teamKey,
          teamObject({
            key: parsed.teamKey,
            name: parsed.team ?? parsed.teamKey,
          }),
        )
      }
      claims.push({
        subjectRef: linearTeamDedupKey(parsed.teamKey),
        subjectKind: "Team",
        objectRef: issueKey,
        objectKind: "Issue",
        predicate: "OWNS",
        sourceId: sourceId(path, "OWNS", parsed.identifier),
        sourceType: "git",
        extractionMethod: "deterministic",
        confidence: 0.95,
        provenance: { path },
      })
    }

    for (const reference of parsed.githubPullRequests) {
      const pull = parseGithubPullRequestUrl(reference.url)
      if (!pull) continue
      const sourceRepositoryId = await resolveSourceRepositoryId({
        orgId: state.orgId,
        repository: pull.repository,
        githubConnectionId: state.githubConnectionId,
        cache: repositoryIds,
      })
      claims.push({
        subjectRef: issueKey,
        subjectKind: "Issue",
        objectRef: pullRequestDedupKey({
          sourceRepositoryId,
          repository: pull.repository,
          number: pull.number,
        }),
        objectKind: "PullRequest",
        predicate: "REFERENCES",
        sourceId: sourceId(
          path,
          "REFERENCES",
          `${pull.repository}#${pull.number}`,
        ),
        sourceType: "git",
        extractionMethod: "deterministic",
        confidence: 0.9,
        provenance: { path, url: reference.url, state: reference.state },
      })
    }
  }

  return {
    extractedObjects: [...teams.values(), ...objects],
    extractedClaims: claims,
  }
}
