import { connectorPathSegment } from "../connectors/path-segment.js"
import type { GitFileChange } from "../git/file-change.js"

export const BUILDKITE_MANAGED_ROOT = "buildkite"

export type BuildkitePipelineForMirror = {
  id: string
  slug: string
  name: string
  url: string
  repository: string | null
  defaultBranch: string | null
}

export type BuildkiteJobForMirror = {
  name: string
  state: string
  softFailed: boolean
  url: string | null
}

export type BuildkiteBuildForMirror = {
  id: string
  number: number
  url: string
  state: string
  branch: string | null
  commit: string | null
  createdAt: string | null
  finishedAt: string | null
  creatorName: string | null
  pullRequestNumber: string | null
  jobs: BuildkiteJobForMirror[]
}

/**
 * The folder of one pipeline in a Workspace source (ADR-054). The sources
 * sync gives ownership by path prefix, so each pipeline has its own folder.
 */
export function buildkitePipelineRoot(pipelineSlug: string): string {
  return `${BUILDKITE_MANAGED_ROOT}/pipelines/${connectorPathSegment(pipelineSlug)}/`
}

/**
 * One line of plain text, with no control or format character. A format
 * character (such as a bidi override or a zero-width mark) can change how a
 * reader or an agent sees the text. White space folds to one space.
 */
function plainText(value: string, maxLength: number): string {
  const text = value
    .replace(/\s+/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
  // Code points, so that the cut does not split a surrogate pair.
  const chars = Array.from(text)
  return chars.length > maxLength
    ? `${chars.slice(0, maxLength).join("").trimEnd()}…`
    : text
}

/**
 * The most characters of one provider text field. People outside the
 * organization can set a branch name, a job label, or a creator name (for
 * example, in a build of a pull request from a fork). A longer value is cut,
 * and ends with "…".
 */
const MAX_TEXT_LENGTH = 200

/** A URL or a git remote can be longer than a name, but has a limit too. */
const MAX_URL_LENGTH = 2048

function yamlScalar(value: string, maxLength: number): string {
  return JSON.stringify(plainText(value, maxLength))
}

/**
 * Provider text as inline Markdown text. It is on one line, so a line break
 * cannot start a block (a heading, a list item, or a fence). Each Markdown
 * punctuation mark has a backslash, so the text cannot make a link, an
 * image, HTML, a table cell, or emphasis.
 */
function escapeInline(value: string, maxLength = MAX_TEXT_LENGTH): string {
  return plainText(value, maxLength).replace(/[\\`*_[\]()!<>#|]/g, "\\$&")
}

/** An `https:` URL that is safe as a Markdown link target, or null. */
function linkUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === "https:"
      ? url.href.replace(
          /[()]/g,
          (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
        )
      : null
  } catch {
    return null
  }
}

/** `[label](url)` for a safe URL, else the label alone. The label is safe Markdown. */
function link(label: string, url: string | null): string {
  const target = linkUrl(url)
  return target ? `[${label}](${target})` : label
}

/**
 * The `https://github.com/<owner>/<repo>` of a GitHub remote, or null for
 * other hosts. Buildkite gives SSH and HTTPS remotes.
 */
export function githubRepositoryUrl(remote: string | null): string | null {
  const match = remote
    ?.trim()
    .match(
      /^(?:git@github\.com:|(?:https?|ssh):\/\/(?:git@)?github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/,
    )
  return match ? `https://github.com/${match[1]}/${match[2]}` : null
}

/**
 * A git remote without credentials, or null. A remote can hold
 * `user:token@host`, and every Workspace member can read the mirror. A URL
 * keeps its scheme, host, and path only. An scp-style remote keeps its host
 * and path, and the user only when it is `git`, which is not a secret. A
 * remote that does not parse cleanly is not written (fail closed), because a
 * secret with `/`, `?`, `#`, or `@` in it can make a parse go wrong.
 */
function remoteWithoutCredentials(remote: string): string | null {
  const value = remote.trim()
  const scheme = value.match(/^[a-z][a-z0-9+.-]*:\/\//i)
  if (scheme) {
    // The authority stops at the first `/`, `\`, `?`, or `#` of the raw
    // text. An `@` after that point can be the end of a secret that holds
    // one of these characters, and the parser then takes part of the secret
    // as the host.
    const rest = value.slice(scheme[0].length)
    const authorityEnd = rest.search(/[/\\?#]/)
    if (authorityEnd !== -1 && /@|%40/i.test(rest.slice(authorityEnd)))
      return null
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return null
    }
    if (!url.hostname) return null
    return `${url.protocol}//${url.host}${url.pathname}`
  }
  const scp = value.match(/^(?:([^\s@/?#]+)@)?([\w.-]+):([^\s@?#]+)$/)
  if (scp) {
    const [, user, host, path] = scp
    // Without a user, `user:secret` has the same shape. Accept it only when
    // the host is a domain name.
    if (!user && !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(host ?? "")) return null
    return `${user === "git" ? "git@" : ""}${host}:${path}`
  }
  // A bare `host/path`, with no user, query, or fragment.
  return /^[\w.-]+\/[^\s@?#:]*$/.test(value) ? value : null
}

function frontMatter(
  fields: Array<[string, string | number | null]>,
): string[] {
  return [
    "---",
    ...fields.flatMap(([name, value]) =>
      value === null
        ? []
        : [
            `${name}: ${
              typeof value === "number"
                ? value
                : yamlScalar(
                    value,
                    name === "url" ||
                      name.endsWith("_url") ||
                      name === "repository"
                      ? MAX_URL_LENGTH
                      : MAX_TEXT_LENGTH,
                  )
            }`,
          ],
    ),
    "---",
    "",
  ]
}

function renderPipelineMarkdown(input: {
  organizationSlug: string
  pipeline: BuildkitePipelineForMirror
}): string {
  const { pipeline } = input
  const remote = pipeline.repository
    ? remoteWithoutCredentials(pipeline.repository)
    : null
  return [
    ...frontMatter([
      ["source", "buildkite"],
      ["organization", input.organizationSlug],
      ["pipeline", pipeline.slug],
      ["buildkite_id", pipeline.id],
      ["url", pipeline.url],
      ["repository", remote],
      ["default_branch", pipeline.defaultBranch],
    ]),
    `# ${escapeInline(pipeline.name)}`,
    "",
    `- Buildkite: ${link(escapeInline(pipeline.name), pipeline.url)}`,
    ...(remote
      ? [`- Repository: ${escapeInline(remote, MAX_URL_LENGTH)}`]
      : []),
    ...(pipeline.defaultBranch
      ? [`- Default branch: ${escapeInline(pipeline.defaultBranch)}`]
      : []),
    "",
  ].join("\n")
}

/** A job that failed the build. A soft fail does not fail the build. */
const FAILED_STATES = new Map([
  ["failed", ""],
  ["timed_out", " (timed out)"],
])

function renderBuildMarkdown(input: {
  organizationSlug: string
  pipeline: BuildkitePipelineForMirror
  build: BuildkiteBuildForMirror
}): string {
  const { pipeline, build } = input
  // A pull request is in the repository of the pipeline, also when its
  // branch is in a fork.
  const repository = githubRepositoryUrl(pipeline.repository)
  const commitUrl =
    repository && build.commit && /^[0-9a-f]{7,40}$/i.test(build.commit)
      ? `${repository}/commit/${build.commit}`
      : null
  const pullRequestUrl =
    repository &&
    build.pullRequestNumber &&
    /^\d+$/.test(build.pullRequestNumber)
      ? `${repository}/pull/${build.pullRequestNumber}`
      : null
  const lines = [
    ...frontMatter([
      ["source", "buildkite"],
      ["organization", input.organizationSlug],
      ["pipeline", pipeline.slug],
      ["buildkite_id", build.id],
      ["build_number", build.number],
      ["url", build.url],
      ["state", build.state],
      ["branch", build.branch],
      ["commit", build.commit],
      ["commit_url", commitUrl],
      ["pull_request_url", pullRequestUrl],
      ["created_at", build.createdAt],
      ["finished_at", build.finishedAt],
    ]),
    `# ${escapeInline(pipeline.name)} build #${build.number}`,
    "",
    `- Pipeline: [${escapeInline(pipeline.name)}](../pipeline.md)`,
    `- Buildkite: ${link(`#${build.number}`, build.url)}`,
    `- State: ${escapeInline(build.state)}`,
  ]
  if (build.branch) lines.push(`- Branch: ${escapeInline(build.branch)}`)
  if (build.commit)
    lines.push(
      commitUrl
        ? `- Commit: [${build.commit.slice(0, 7)}](${commitUrl})`
        : `- Commit: ${escapeInline(build.commit)}`,
    )
  if (build.pullRequestNumber)
    lines.push(
      pullRequestUrl
        ? `- Pull request: [#${build.pullRequestNumber}](${pullRequestUrl})`
        : `- Pull request: #${escapeInline(build.pullRequestNumber)}`,
    )
  if (build.creatorName)
    lines.push(`- Created by: ${escapeInline(build.creatorName)}`)
  lines.push("", "## Failed jobs", "")
  const failed = build.jobs.filter(
    (job) => FAILED_STATES.has(job.state) && !job.softFailed,
  )
  if (!failed.length) lines.push("No job failed.")
  for (const job of failed) {
    lines.push(
      `- ${link(escapeInline(job.name), job.url)}${FAILED_STATES.get(job.state)}`,
    )
  }
  lines.push("")
  return lines.join("\n")
}

/** The files of one pipeline: `pipeline.md`, and one file for each build. */
export function buildkitePipelineFiles(input: {
  organizationSlug: string
  pipeline: BuildkitePipelineForMirror
  builds: BuildkiteBuildForMirror[]
}): GitFileChange[] {
  const root = buildkitePipelineRoot(input.pipeline.slug)
  return [
    { path: `${root}pipeline.md`, content: renderPipelineMarkdown(input) },
    ...input.builds.map((build) => ({
      path: `${root}builds/${connectorPathSegment(String(build.number))}.md`,
      content: renderBuildMarkdown({ ...input, build }),
    })),
  ]
}
