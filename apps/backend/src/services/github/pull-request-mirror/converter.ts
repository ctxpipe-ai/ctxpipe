import { parse as parseYaml, stringify } from "yaml"
import type {
  GithubPrActor,
  GithubPrFileChange,
  GithubPrMirrorFile,
  GithubPrRequiredCheck,
  GithubPullRequestSnapshot,
} from "./types.js"
import { GITHUB_PR_FILE_STATUSES } from "./types.js"

export const GITHUB_PR_MIRROR_ROOT = "github"
export const GITHUB_PR_CONFIG_PATH = "github/config.yaml"
export const GITHUB_PR_PULLS_PREFIX = "github/pulls/"

export function githubPullRequestMarkdownPath(
  repository: string,
  number: number,
  id: number,
): string {
  const [owner, repo] = repository.split("/")
  if (!owner || !repo) {
    throw new Error(`Invalid repository name "${repository}"`)
  }
  return `${GITHUB_PR_PULLS_PREFIX}${owner}/${repo}/${number}--${id}.md`
}

export function isGithubPullRequestMirrorPath(path: string): boolean {
  const normalised = path.replace(/\\/g, "/")
  return (
    normalised === GITHUB_PR_CONFIG_PATH ||
    normalised.startsWith(GITHUB_PR_PULLS_PREFIX)
  )
}

function frontmatter(metadata: Record<string, unknown>): string {
  return `---\n${stringify(metadata).trimEnd()}\n---`
}

function actorLine(actor: GithubPrActor): string {
  return actor.type === "bot" ? `${actor.login} (bot)` : actor.login
}

function heading(title: string): string {
  const trimmed = title.trim() || "Untitled pull request"
  return `# ${trimmed}`
}

export function renderGithubPullRequest(
  snapshot: GithubPullRequestSnapshot,
): GithubPrMirrorFile {
  const sections = [
    frontmatter({
      source: "github",
      type: "pull_request",
      id: snapshot.id,
      number: snapshot.number,
      repository: snapshot.repository,
      url: snapshot.url,
      title: snapshot.title,
      state: snapshot.state,
      merged: snapshot.merged,
      draft: snapshot.draft,
      author: snapshot.author.login,
      authorType: snapshot.author.type,
      base: snapshot.base,
      head: snapshot.head,
      reviewDecision: snapshot.reviewDecision,
      labels: snapshot.labels,
      requestedReviewers: snapshot.requestedReviewers,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      mergedAt: snapshot.mergedAt,
      files: snapshot.files,
      requiredChecks: snapshot.requiredChecks,
    }),
    heading(snapshot.title),
    snapshot.body.trim() || "_No description._",
  ]

  if (snapshot.reviews.length > 0) {
    sections.push(
      "## Reviews",
      ...snapshot.reviews.map((review) => {
        const when = review.submittedAt ?? "unknown time"
        const body = review.body.trim() || "_No review body._"
        return `### ${actorLine(review.author)} — ${review.state}\n\n${when}\n\n${body}`
      }),
    )
  }

  if (snapshot.comments.length > 0) {
    sections.push(
      "## Conversation",
      ...snapshot.comments.map((comment) => {
        const loc =
          comment.path != null
            ? `\n\n\`${comment.path}${comment.line != null ? `:${comment.line}` : ""}\``
            : ""
        return `### ${comment.createdAt} · ${actorLine(comment.author)}${loc}\n\n${comment.body}`
      }),
    )
  }

  return {
    path: githubPullRequestMarkdownPath(
      snapshot.repository,
      snapshot.number,
      snapshot.id,
    ),
    content: `${sections.join("\n\n").trim()}\n`,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function parseActor(login: unknown, type: unknown): GithubPrActor | null {
  const name = asString(login)
  if (!name) return null
  return { login: name, type: type === "bot" ? "bot" : "human" }
}

function parseFiles(value: unknown): GithubPrFileChange[] {
  if (!Array.isArray(value)) return []
  const files: GithubPrFileChange[] = []
  for (const entry of value) {
    const row = asRecord(entry)
    if (!row) continue
    const path = asString(row.path)
    const status = asString(row.status)
    if (
      !path ||
      !status ||
      !GITHUB_PR_FILE_STATUSES.includes(
        status as (typeof GITHUB_PR_FILE_STATUSES)[number],
      )
    ) {
      continue
    }
    const previousPath = asString(row.previousPath)
    files.push({
      path,
      status: status as GithubPrFileChange["status"],
      ...(previousPath ? { previousPath } : {}),
    })
  }
  return files
}

function parseRef(value: unknown): { ref: string; sha: string } | null {
  const row = asRecord(value)
  if (!row) return null
  const ref = asString(row.ref)
  const sha = asString(row.sha)
  if (!ref || !sha) return null
  return { ref, sha }
}

function parseChecks(value: unknown): GithubPrRequiredCheck[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const row = asRecord(entry)
    const name = row ? asString(row.name) : null
    if (!name) return []
    return [
      {
        name,
        conclusion: asString(row?.conclusion),
      },
    ]
  })
}

export type ParsedGithubPullRequest = {
  id: number
  number: number
  repository: string
  url: string
  title: string
  state: "open" | "closed"
  merged: boolean
  draft: boolean
  author: GithubPrActor
  base: { ref: string; sha: string }
  head: { ref: string; sha: string }
  reviewDecision: string | null
  labels: string[]
  requestedReviewers: string[]
  createdAt: string
  updatedAt: string
  mergedAt: string | null
  files: GithubPrFileChange[]
  requiredChecks: GithubPrRequiredCheck[]
  /** Description text after the title heading, before reviews / conversation (≤ 2000 chars). */
  bodyExcerpt: string
}

function bodyExcerptAfterFrontmatter(rest: string): string {
  let body = rest.replace(/^\s+/, "")
  if (body.startsWith("# ")) {
    const newline = body.indexOf("\n")
    body = newline === -1 ? "" : body.slice(newline + 1)
  }
  const cut = body.search(/\n## (Reviews|Conversation)\b/)
  if (cut !== -1) body = body.slice(0, cut)
  return body.trim().slice(0, 2_000)
}

export function parseGithubPullRequestMarkdown(
  content: string,
): ParsedGithubPullRequest | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) return null
  let parsed: unknown
  try {
    parsed = parseYaml(match[1])
  } catch {
    return null
  }
  const data = asRecord(parsed)
  if (!data) return null
  if (data.source !== "github" || data.type !== "pull_request") return null

  const id = asNumber(data.id)
  const number = asNumber(data.number)
  const repository = asString(data.repository)
  const url = asString(data.url)
  const title = asString(data.title)
  const state =
    data.state === "open" || data.state === "closed" ? data.state : null
  const author = parseActor(data.author, data.authorType)
  const base = parseRef(data.base)
  const head = parseRef(data.head)
  const createdAt = asString(data.createdAt)
  const updatedAt = asString(data.updatedAt)
  if (
    id == null ||
    number == null ||
    !repository ||
    !url ||
    !title ||
    !state ||
    !author ||
    !base ||
    !head ||
    !createdAt ||
    !updatedAt
  ) {
    return null
  }

  return {
    id,
    number,
    repository,
    url,
    title,
    state,
    merged: asBoolean(data.merged, false),
    draft: asBoolean(data.draft, false),
    author,
    base,
    head,
    reviewDecision: asString(data.reviewDecision),
    labels: Array.isArray(data.labels)
      ? data.labels.filter(
          (label): label is string => typeof label === "string",
        )
      : [],
    requestedReviewers: Array.isArray(data.requestedReviewers)
      ? data.requestedReviewers.filter(
          (login): login is string => typeof login === "string",
        )
      : [],
    createdAt,
    updatedAt,
    mergedAt: asString(data.mergedAt),
    files: parseFiles(data.files),
    requiredChecks: parseChecks(data.requiredChecks),
    bodyExcerpt: bodyExcerptAfterFrontmatter(content.slice(match[0].length)),
  }
}
