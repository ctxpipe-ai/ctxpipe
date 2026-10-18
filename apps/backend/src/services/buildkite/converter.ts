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
  return `${BUILDKITE_MANAGED_ROOT}/pipelines/${pipelineSlug}/`
}

/**
 * One line of plain text, with no control or format character. A format
 * character (such as a bidi override or a zero-width mark) can change how a
 * reader or an agent sees the text. White space folds to one space.
 */
function plainText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
}

function yamlScalar(value: string): string {
  return JSON.stringify(plainText(value))
}

/**
 * Provider text as inline Markdown text. It is on one line, so a line break
 * cannot start a block (a heading, a list item, or a fence). Each Markdown
 * punctuation mark has a backslash, so the text cannot make a link, an
 * image, HTML, a table cell, or emphasis.
 */
function escapeInline(value: string): string {
  return plainText(value).replace(/[\\`*_[\]()!<>#|]/g, "\\$&")
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
 * A git remote without credentials. A remote can hold `user:token@host`, and
 * every Workspace member can read the mirror. A URL keeps its scheme, host,
 * and path only. The user of an SSH remote in the `user@host:path` form is
 * kept when it is `git`, which is not a secret. Text that has no user part
 * is not changed.
 */
function remoteWithoutCredentials(remote: string): string {
  const match = remote
    .trim()
    .match(/^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*@)?([\s\S]*)$/i)
  const [, scheme, userInfo, rest = ""] = match ?? []
  if (!scheme) return userInfo === "git@" || !userInfo ? remote : rest
  return `${scheme}${rest.replace(/[?#][\s\S]*$/, "")}`
}

function frontMatter(
  fields: Array<[string, string | number | null]>,
): string[] {
  return [
    "---",
    ...fields.flatMap(([name, value]) =>
      value === null
        ? []
        : [`${name}: ${typeof value === "number" ? value : yamlScalar(value)}`],
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
  const remote =
    pipeline.repository && remoteWithoutCredentials(pipeline.repository)
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
    ...(remote ? [`- Repository: ${escapeInline(remote)}`] : []),
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
      path: `${root}builds/${build.number}.md`,
      content: renderBuildMarkdown({ ...input, build }),
    })),
  ]
}
