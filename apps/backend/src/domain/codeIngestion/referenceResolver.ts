/**
 * Reference resolver (ADR-033): the one place that turns provider URLs,
 * identifiers and repo paths into graph deduplication keys. Every extractor
 * uses these builders so images of the same real-world thing coincide.
 *
 * Pure functions only. Repository-name → repository-id lookups live in
 * `graphs/codeIngestionGraph/nodes/repositoryResolution.ts`.
 */

export type GithubPullRequestRef = {
  owner: string
  repo: string
  repository: string
  number: number
}

export function parseGithubPullRequestUrl(
  rawUrl: string,
): GithubPullRequestRef | null {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    return null
  }
  if (url.hostname.toLowerCase() !== "github.com") return null
  const parts = url.pathname.split("/").filter(Boolean)
  const [owner, repo, kind, number] = parts
  if (!owner || !repo || kind !== "pull" || !number || !/^\d+$/.test(number)) {
    return null
  }
  return {
    owner,
    repo,
    repository: `${owner}/${repo}`,
    number: Number(number),
  }
}

/** `prq:${sourceRepositoryId}:${number}`; falls back to the GitHub name when unresolved. */
export function pullRequestDedupKey(input: {
  sourceRepositoryId?: string | null
  repository: string
  number: number
}): string {
  const scope = input.sourceRepositoryId ?? `github:${input.repository}`
  return `prq:${scope}:${input.number}`
}

const LINEAR_IDENTIFIER = /^([A-Z][A-Z0-9]{0,9})-(\d+)$/

export function normalizeLinearIdentifier(value: string): string | null {
  const trimmed = value.trim().toUpperCase()
  return LINEAR_IDENTIFIER.test(trimmed) ? trimmed : null
}

/** Linear issue identity is org-scoped: `iss:linear:${IDENTIFIER}`. */
export function issueDedupKey(identifier: string): string {
  const normalized = normalizeLinearIdentifier(identifier)
  if (!normalized) throw new Error(`Invalid Linear identifier "${identifier}"`)
  return `iss:linear:${normalized}`
}

export function parseLinearIssueUrl(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    return null
  }
  if (url.hostname.toLowerCase() !== "linear.app") return null
  const parts = url.pathname.split("/").filter(Boolean)
  const issueIndex = parts.indexOf("issue")
  const identifier = issueIndex >= 0 ? parts[issueIndex + 1] : undefined
  return identifier ? normalizeLinearIdentifier(identifier) : null
}

/**
 * Bare identifiers (`ENG-123`) in free text, restricted to known team keys so
 * `UTF-8`, `SHA-256`, `ISO-8601` never match. Returns distinct, normalized.
 */
export function findLinearIdentifiers(
  text: string,
  teamKeys: ReadonlyArray<string>,
): string[] {
  const keys = [...new Set(teamKeys.map((key) => key.toUpperCase()))].filter(
    (key) => /^[A-Z][A-Z0-9]{0,9}$/.test(key),
  )
  if (keys.length === 0 || text.length === 0) return []
  const pattern = new RegExp(`\\b(${keys.join("|")})-(\\d+)\\b`, "gi")
  const found = new Set<string>()
  for (const match of text.matchAll(pattern)) {
    const identifier = normalizeLinearIdentifier(`${match[1]}-${match[2]}`)
    if (identifier) found.add(identifier)
  }
  return [...found]
}

export function linearTeamDedupKey(teamKey: string): string {
  const normalized = teamKey.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(normalized)) {
    throw new Error(`Invalid Linear team key "${teamKey}"`)
  }
  return `team:linear:${normalized}`
}

export function githubTeamDedupKey(org: string, slug: string): string {
  return `team:github:${org.toLowerCase()}/${slug.toLowerCase()}`
}

/** CODEOWNERS owner token `@org/team` → key; individual `@user` owners return null. */
export function parseGithubTeamOwner(token: string): string | null {
  const match =
    /^@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)$/.exec(
      token.trim(),
    )
  if (!match?.[1] || !match[2]) return null
  return githubTeamDedupKey(match[1], match[2])
}

export type SlackPermalinkRef = { channelId: string; ts: string }

/** `https://{team}.slack.com/archives/{C…}/p{ts-without-dot}[?thread_ts=…]` */
export function parseSlackPermalink(rawUrl: string): SlackPermalinkRef | null {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    return null
  }
  if (!url.hostname.toLowerCase().endsWith(".slack.com")) return null
  const match = /^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})$/.exec(url.pathname)
  if (!match?.[1] || !match[2] || !match[3]) return null
  const threadTs = url.searchParams.get("thread_ts")
  return {
    channelId: match[1],
    ts:
      threadTs && /^\d+\.\d+$/.test(threadTs)
        ? threadTs
        : `${match[2]}.${match[3]}`,
  }
}

export function threadDedupKey(channelId: string, threadTs: string): string {
  return `thr:slack:${channelId}:${threadTs}`
}

export function decisionDedupKey(repositoryId: string, path: string): string {
  return `dec:${repositoryId}:${path}`
}

/** `ADR-031`, `ADR 031`, `adr-0031` → `ADR-031` (number kept as written, sans leading zeros). */
export function findAdrReferences(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/\bADR[-\s]?0*(\d{1,5})\b/gi)) {
    if (match[1]) found.add(`ADR-${Number(match[1])}`)
  }
  return [...found]
}

const URL_PATTERN = /https?:\/\/[^\s<>()[\]"'`]+/g

/** Distinct http(s) URLs in free text, trailing punctuation trimmed. */
export function extractUrls(text: string): string[] {
  const urls = new Set<string>()
  for (const match of text.matchAll(URL_PATTERN)) {
    urls.add(match[0].replace(/[.,;:!?)]+$/, ""))
  }
  return [...urls]
}

/**
 * Repo-relative paths written in backticks (`apps/backend/src/x.ts`). Only
 * candidates with a directory separator and a file extension are returned;
 * existence is checked by the link pass against known File nodes.
 */
export function extractBacktickedPaths(text: string): string[] {
  const paths = new Set<string>()
  for (const match of text.matchAll(/`([^`\s]+)`/g)) {
    const candidate = (match[1] ?? "").replace(/^\.\//, "")
    if (!candidate.includes("/")) continue
    if (candidate.startsWith("/") || candidate.includes("..")) continue
    if (candidate.includes("://")) continue
    if (!/\.[A-Za-z0-9]{1,12}$/.test(candidate)) continue
    paths.add(candidate)
  }
  return [...paths]
}

/** ISO date (YYYY-MM-DD) from an ISO timestamp, for claim validity. */
export function isoDateOf(
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString().slice(0, 10)
}
