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
 * The folder of one pipeline in a Workspace source (ADR-053). The sources
 * sync gives ownership by path prefix, so each pipeline has its own folder.
 */
export function buildkitePipelineRoot(pipelineSlug: string): string {
  return `${BUILDKITE_MANAGED_ROOT}/pipelines/${pipelineSlug}/`
}

function yamlScalar(value: string): string {
  return JSON.stringify(value)
}

/** Link text without the brackets that would end it. */
function linkText(value: string): string {
  return value.replace(/\s*\n\s*/g, " ").replace(/[[\]]/g, "\\$&")
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
  return [
    ...frontMatter([
      ["source", "buildkite"],
      ["organization", input.organizationSlug],
      ["pipeline", pipeline.slug],
      ["buildkite_id", pipeline.id],
      ["url", pipeline.url],
      ["repository", pipeline.repository],
      ["default_branch", pipeline.defaultBranch],
    ]),
    `# ${pipeline.name}`,
    "",
    `- Buildkite: [${linkText(pipeline.name)}](${pipeline.url})`,
    ...(pipeline.repository ? [`- Repository: ${pipeline.repository}`] : []),
    ...(pipeline.defaultBranch
      ? [`- Default branch: ${pipeline.defaultBranch}`]
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
    repository && build.commit ? `${repository}/commit/${build.commit}` : null
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
    `# ${pipeline.name} build #${build.number}`,
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
  if (build.pullRequestNumber)
    lines.push(
      pullRequestUrl
        ? `- Pull request: [#${build.pullRequestNumber}](${pullRequestUrl})`
        : `- Pull request: #${build.pullRequestNumber}`,
    )
  if (build.creatorName) lines.push(`- Created by: ${build.creatorName}`)
  lines.push("", "## Failed jobs", "")
  const failed = build.jobs.filter(
    (job) => FAILED_STATES.has(job.state) && !job.softFailed,
  )
  if (!failed.length) lines.push("No job failed.")
  for (const job of failed) {
    const name = job.url ? `[${linkText(job.name)}](${job.url})` : job.name
    lines.push(`- ${name}${FAILED_STATES.get(job.state)}`)
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
