import type { GitFileChange } from "../git/file-change.js"

export const BUILDKITE_MANAGED_ROOT = "buildkite"

export type BuildkitePipelineForMirror = {
  id: string
  slug: string
  name: string
  description: string | null
  url: string
  repository: string | null
  defaultBranch: string | null
  createdAt: string | null
  archivedAt: string | null
}

export type BuildkiteJobForMirror = {
  name: string
  state: string
  exitStatus: number | null
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
  message: string | null
  createdAt: string | null
  startedAt: string | null
  finishedAt: string | null
  /** The person who started the build in Buildkite, if one did. */
  creatorName: string | null
  /** The commit author that the source control webhook gave. */
  authorName: string | null
  pullRequest: { number: string; repository: string | null } | null
  jobs: BuildkiteJobForMirror[]
}

/**
 * The folder of one pipeline in a Workspace source (ADR-053). The sources
 * sync gives ownership by path prefix, so each pipeline has its own folder.
 */
export function buildkitePipelineRoot(pipelineSlug: string): string {
  return `${BUILDKITE_MANAGED_ROOT}/pipelines/${pipelineSlug}/`
}

function yamlScalar(value: string): string {
  return JSON.stringify(value)
}

/** One Markdown table cell: no line breaks, and an escaped `|`. */
function cell(value: string): string {
  return value.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|")
}

/** Link text without the brackets that would end it. */
function linkText(value: string): string {
  return cell(value).replace(/[[\]]/g, "\\$&")
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

function firstLine(text: string | null): string {
  return text?.trim().split("\n")[0]?.trim() ?? ""
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
  builds: BuildkiteBuildForMirror[]
}): string {
  const { pipeline, builds } = input
  const lines = [
    ...frontMatter([
      ["source", "buildkite"],
      ["organization", input.organizationSlug],
      ["pipeline", pipeline.slug],
      ["buildkite_id", pipeline.id],
      ["url", pipeline.url],
      ["repository", pipeline.repository],
      ["default_branch", pipeline.defaultBranch],
      ["created_at", pipeline.createdAt],
      ["archived_at", pipeline.archivedAt],
    ]),
    `# ${pipeline.name}`,
    "",
  ]
  if (pipeline.description?.trim()) lines.push(pipeline.description.trim(), "")
  lines.push(`- Buildkite: [${linkText(pipeline.name)}](${pipeline.url})`)
  if (pipeline.repository) lines.push(`- Repository: ${pipeline.repository}`)
  if (pipeline.defaultBranch)
    lines.push(`- Default branch: ${pipeline.defaultBranch}`)
  if (pipeline.archivedAt) lines.push(`- Archived: ${pipeline.archivedAt}`)
  lines.push("", "## Latest builds", "")
  if (!builds.length) {
    lines.push("No finished builds.", "")
    return lines.join("\n")
  }
  lines.push(
    "| Build | State | Branch | Commit | Finished |",
    "| --- | --- | --- | --- | --- |",
    ...builds.map(
      (build) =>
        `| [#${build.number}](builds/${build.number}.md) | ${cell(build.state)} | ${cell(build.branch ?? "")} | ${cell(build.commit?.slice(0, 7) ?? "")} | ${cell(build.finishedAt ?? "")} |`,
    ),
    "",
  )
  return lines.join("\n")
}

function renderBuildMarkdown(input: {
  organizationSlug: string
  pipeline: BuildkitePipelineForMirror
  build: BuildkiteBuildForMirror
}): string {
  const { pipeline, build } = input
  const repository = githubRepositoryUrl(
    build.pullRequest?.repository ?? pipeline.repository,
  )
  const commitUrl =
    repository && build.commit ? `${repository}/commit/${build.commit}` : null
  const pullRequestUrl =
    repository && build.pullRequest && /^\d+$/.test(build.pullRequest.number)
      ? `${repository}/pull/${build.pullRequest.number}`
      : null
  const title = firstLine(build.message)
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
      ["started_at", build.startedAt],
      ["finished_at", build.finishedAt],
    ]),
    `# ${pipeline.name} build #${build.number}${title ? `: ${title}` : ""}`,
    "",
    `- Pipeline: [${linkText(pipeline.name)}](../pipeline.md)`,
    `- Buildkite: [#${build.number}](${build.url})`,
    `- State: ${build.state}`,
  ]
  if (build.branch) lines.push(`- Branch: ${build.branch}`)
  if (build.commit)
    lines.push(
      commitUrl
        ? `- Commit: [${build.commit.slice(0, 7)}](${commitUrl})`
        : `- Commit: ${build.commit}`,
    )
  if (build.pullRequest)
    lines.push(
      pullRequestUrl
        ? `- Pull request: [#${build.pullRequest.number}](${pullRequestUrl})`
        : `- Pull request: #${build.pullRequest.number}`,
    )
  if (build.authorName) lines.push(`- Author: ${build.authorName}`)
  if (build.creatorName) lines.push(`- Started by: ${build.creatorName}`)
  if (build.startedAt) lines.push(`- Started: ${build.startedAt}`)
  if (build.finishedAt) lines.push(`- Finished: ${build.finishedAt}`)
  lines.push("")
  const message = build.message?.trim()
  if (message && message !== title) lines.push("## Message", "", message, "")

  lines.push("## Jobs", "")
  if (!build.jobs.length) {
    lines.push("No command or trigger steps.", "")
    return lines.join("\n")
  }
  const failed = build.jobs.filter(
    (job) => job.state === "failed" || job.state === "timed_out",
  )
  if (failed.length)
    lines.push(
      `${failed.length} of ${build.jobs.length} jobs failed: ${failed.map((job) => job.name).join(", ")}.`,
      "",
    )
  lines.push(
    "| Job | State | Exit status |",
    "| --- | --- | --- |",
    ...build.jobs.map((job) => {
      const name = job.url
        ? `[${linkText(job.name)}](${job.url})`
        : cell(job.name)
      const state = job.softFailed ? `${job.state} (soft fail)` : job.state
      return `| ${name} | ${cell(state)} | ${job.exitStatus ?? ""} |`
    }),
    "",
  )
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
    {
      path: `${root}pipeline.md`,
      content: renderPipelineMarkdown(input),
    },
    ...input.builds.map((build) => ({
      path: `${root}builds/${build.number}.md`,
      content: renderBuildMarkdown({ ...input, build }),
    })),
  ]
}
