import {
  fetchFiles,
  globFiles,
} from "../../../domain/codeIngestion/codesearchClient.js"
import { buildEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import {
  extractUrls,
  findLinearIdentifiers,
  issueDedupKey,
  parseGithubPullRequestUrl,
  parseLinearIssueUrl,
  pullRequestDedupKey,
  threadDedupKey,
} from "../../../domain/codeIngestion/referenceResolver.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"
import { asString, splitFrontmatter } from "./connectorFrontmatter.js"
import { listLinearTeamKeys } from "./linkLocatedPaths.js"
import {
  filterPathsByPartialScan,
  partialScanPathsForExtractors,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"
import {
  type RepositoryIdCache,
  resolveSourceRepositoryId,
} from "./repositoryResolution.js"

export const SLACK_THREADS_GLOB = "slack/channels/**/thread.md"
const EXCERPT_MAX = 2_000

export type ParsedSlackThread = {
  channelId: string
  channelName: string
  threadTs: string
  permalink: string | null
  capturedAt: string | null
  messageCount: number | null
  isPrivate: boolean
  /** Message bodies only: headings (author · time) and asset link lines removed. */
  messages: string[]
  excerpt: string
}

/** Frontmatter and body written by the Slack capture renderer (services/slack/converter.ts). */
export function parseSlackThreadMarkdown(
  content: string,
): ParsedSlackThread | null {
  const split = splitFrontmatter(content)
  if (!split) return null
  const { data, body } = split
  if (data.source !== "slack") return null
  const channelId = asString(data.channel_id)
  const threadTs =
    typeof data.thread_ts === "number"
      ? String(data.thread_ts)
      : asString(data.thread_ts)
  if (!channelId || !threadTs) return null

  const messages: string[] = []
  let current: string[] = []
  const flush = () => {
    const text = current.join("\n").trim()
    if (text.length > 0) messages.push(text)
    current = []
  }
  for (const line of body.split("\n")) {
    if (line.startsWith("#")) {
      flush()
      continue
    }
    if (/^!?\[[^\]]*\]\([^)]*\)\s*$/.test(line.trim())) continue
    current.push(line)
  }
  flush()

  const messageCount =
    typeof data.message_count === "number" ? data.message_count : null
  return {
    channelId,
    channelName: asString(data.channel_name) ?? channelId,
    threadTs,
    permalink: asString(data.permalink),
    capturedAt: asString(data.captured_at),
    messageCount,
    isPrivate: data.is_private === true,
    messages,
    excerpt: messages.join("\n\n").slice(0, EXCERPT_MAX),
  }
}

/**
 * Connector extractor for `slack/` (ADR-033): one `Thread` per captured
 * thread plus `Thread REFERENCES PullRequest | Issue` for GitHub PR URLs,
 * Linear URLs and bare Linear identifiers (known team keys only). No user ids
 * leave the warehouse (ADR-025).
 */
export async function extractSlackThreads(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  if (shouldSkipExtractorForPartialDeletesOnly(state)) return {}

  const scanPaths = partialScanPathsForExtractors(state)
  const globbed = await globFiles(state.repositoryId, state.orgId, {
    pattern: SLACK_THREADS_GLOB,
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

  const [contents, teamKeys] = await Promise.all([
    fetchFiles(state.repositoryId, state.orgId, scopedPaths),
    listLinearTeamKeys(state.orgId),
  ])

  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []
  const repositoryIds: RepositoryIdCache = new Map()
  const sourceId = (path: string, target: string) =>
    buildEvidenceSourceId({
      extractor: "slackThread",
      repositoryId: state.repositoryId,
      segments: [path, "REFERENCES", target],
      targetHash: state.targetHash,
    })

  for (const path of scopedPaths) {
    const content = contents[path]
    if (!content) continue
    const parsed = parseSlackThreadMarkdown(content)
    if (!parsed) continue
    const threadKey = threadDedupKey(parsed.channelId, parsed.threadTs)
    const first = parsed.messages[0] ?? ""
    objects.push({
      kind: "Thread",
      deduplicationKey: threadKey,
      name: first
        ? `#${parsed.channelName}: ${first.replace(/\s+/g, " ").slice(0, 80)}`
        : `#${parsed.channelName} thread ${parsed.threadTs}`,
      summary: first.slice(0, 500),
      payload: {
        channel_id: parsed.channelId,
        channel_name: parsed.channelName,
        permalink: parsed.permalink,
        captured_at: parsed.capturedAt,
        message_count: parsed.messageCount,
        is_private: parsed.isPrivate,
        excerpt: parsed.excerpt,
      },
    })

    const seen = new Set<string>()
    const reference = (
      objectRef: string,
      objectKind: "PullRequest" | "Issue",
      target: string,
      provenance: Record<string, unknown>,
    ) => {
      if (seen.has(objectRef)) return
      seen.add(objectRef)
      claims.push({
        subjectRef: threadKey,
        subjectKind: "Thread",
        objectRef,
        objectKind,
        predicate: "REFERENCES",
        sourceId: sourceId(path, target),
        sourceType: "git",
        extractionMethod: "deterministic",
        confidence: 0.9,
        provenance: { path, ...provenance },
      })
    }

    const text = parsed.messages.join("\n")
    for (const url of extractUrls(text)) {
      const pull = parseGithubPullRequestUrl(url)
      if (pull) {
        const sourceRepositoryId = await resolveSourceRepositoryId({
          orgId: state.orgId,
          repository: pull.repository,
          githubConnectionId: state.githubConnectionId,
          cache: repositoryIds,
        })
        reference(
          pullRequestDedupKey({
            sourceRepositoryId,
            repository: pull.repository,
            number: pull.number,
          }),
          "PullRequest",
          `${pull.repository}#${pull.number}`,
          { url },
        )
        continue
      }
      const identifier = parseLinearIssueUrl(url)
      if (identifier) {
        reference(issueDedupKey(identifier), "Issue", identifier, {
          url,
          identifier,
        })
      }
    }
    for (const identifier of findLinearIdentifiers(text, teamKeys)) {
      reference(issueDedupKey(identifier), "Issue", identifier, { identifier })
    }
  }

  return { extractedObjects: objects, extractedClaims: claims }
}
