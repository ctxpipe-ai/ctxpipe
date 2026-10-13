import { describe, expect, it } from "vitest"
import {
  type BuildkiteBuildForMirror,
  type BuildkitePipelineForMirror,
  buildkitePipelineFiles,
  githubRepositoryUrl,
} from "./converter.js"

const pipeline: BuildkitePipelineForMirror = {
  id: "0b8f7c34-pipeline",
  slug: "web-app",
  name: "Web App",
  url: "https://buildkite.com/acme/web-app",
  repository: "git@github.com:acme/web-app.git",
  defaultBranch: "main",
}

const build: BuildkiteBuildForMirror = {
  id: "7d3a1c2e-build",
  number: 42,
  url: "https://buildkite.com/acme/web-app/builds/42",
  state: "failed",
  branch: "feature/login",
  commit: "abc1234def5678",
  createdAt: "2026-10-12T10:00:00.000Z",
  finishedAt: "2026-10-12T10:07:00.000Z",
  creatorName: "Sam Rivera",
  pullRequestNumber: "17",
  jobs: [
    {
      name: ":rspec: Unit [tests]",
      state: "failed",
      softFailed: false,
      url: "https://buildkite.com/acme/web-app/builds/42#job-1",
    },
    { name: "Lint | format", state: "passed", softFailed: false, url: null },
    { name: "Flaky check", state: "failed", softFailed: true, url: null },
    { name: "Deploy | prod", state: "timed_out", softFailed: false, url: null },
  ],
}

describe("buildkitePipelineFiles", () => {
  const files = buildkitePipelineFiles({
    organizationSlug: "acme",
    pipeline,
    builds: [build],
  })
  const file = (path: string) =>
    files.find((candidate) => candidate.path === path)?.content ?? ""

  it("writes the pipeline file and one file for each build", () => {
    expect(files.map((candidate) => candidate.path)).toEqual([
      "buildkite/pipelines/web-app/pipeline.md",
      "buildkite/pipelines/web-app/builds/42.md",
    ])
  })

  it("renders the name, repository, default branch, and link of the pipeline", () => {
    expect(file("buildkite/pipelines/web-app/pipeline.md")).toBe(
      [
        "---",
        'source: "buildkite"',
        'organization: "acme"',
        'pipeline: "web-app"',
        'buildkite_id: "0b8f7c34-pipeline"',
        'url: "https://buildkite.com/acme/web-app"',
        'repository: "git@github.com:acme/web-app.git"',
        'default_branch: "main"',
        "---",
        "",
        "# Web App",
        "",
        "- Buildkite: [Web App](https://buildkite.com/acme/web-app)",
        "- Repository: git@github.com:acme/web-app.git",
        "- Default branch: main",
        "",
      ].join("\n"),
    )
  })

  it("renders a build with its GitHub links, creator, and failed jobs", () => {
    expect(file("buildkite/pipelines/web-app/builds/42.md")).toBe(
      [
        "---",
        'source: "buildkite"',
        'organization: "acme"',
        'pipeline: "web-app"',
        'buildkite_id: "7d3a1c2e-build"',
        "build_number: 42",
        'url: "https://buildkite.com/acme/web-app/builds/42"',
        'state: "failed"',
        'branch: "feature/login"',
        'commit: "abc1234def5678"',
        'commit_url: "https://github.com/acme/web-app/commit/abc1234def5678"',
        'pull_request_url: "https://github.com/acme/web-app/pull/17"',
        'created_at: "2026-10-12T10:00:00.000Z"',
        'finished_at: "2026-10-12T10:07:00.000Z"',
        "---",
        "",
        "# Web App build #42",
        "",
        "- Pipeline: [Web App](../pipeline.md)",
        "- Buildkite: [#42](https://buildkite.com/acme/web-app/builds/42)",
        "- State: failed",
        "- Branch: feature/login",
        "- Commit: [abc1234](https://github.com/acme/web-app/commit/abc1234def5678)",
        "- Pull request: [#17](https://github.com/acme/web-app/pull/17)",
        "- Created by: Sam Rivera",
        "",
        "## Failed jobs",
        "",
        // A soft-failed job does not fail the build, so it is not listed.
        "- [:rspec: Unit \\[tests\\]](https://buildkite.com/acme/web-app/builds/42#job-1)",
        "- Deploy | prod (timed out)",
        "",
      ].join("\n"),
    )
  })

  it("says when no job failed", () => {
    const [, buildFile] = buildkitePipelineFiles({
      organizationSlug: "acme",
      pipeline,
      builds: [{ ...build, state: "passed", jobs: [] }],
    })
    expect(buildFile?.content).toContain("## Failed jobs\n\nNo job failed.\n")
  })

  it("leaves out the links of a repository that is not on GitHub", () => {
    const [, buildFile] = buildkitePipelineFiles({
      organizationSlug: "acme",
      pipeline: {
        ...pipeline,
        repository: "git@gitlab.com:acme/web-app.git",
      },
      builds: [build],
    })
    expect(buildFile?.content).not.toContain("commit_url")
    expect(buildFile?.content).toContain("- Commit: abc1234def5678")
    expect(buildFile?.content).toContain("- Pull request: #17")
  })
})

describe("githubRepositoryUrl", () => {
  it.each([
    ["git@github.com:acme/web-app.git", "https://github.com/acme/web-app"],
    ["https://github.com/acme/web-app.git", "https://github.com/acme/web-app"],
    ["https://github.com/acme/web.app", "https://github.com/acme/web.app"],
    [
      "ssh://git@github.com/acme/web-app.git",
      "https://github.com/acme/web-app",
    ],
    ["git@gitlab.com:acme/web-app.git", null],
    [null, null],
  ])("maps %s", (remote, expected) => {
    expect(githubRepositoryUrl(remote)).toBe(expected)
  })
})
