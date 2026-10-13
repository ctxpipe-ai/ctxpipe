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
  description: "Builds and deploys the web app.",
  url: "https://buildkite.com/acme/web-app",
  repository: "git@github.com:acme/web-app.git",
  defaultBranch: "main",
  createdAt: "2026-01-02T03:04:05.000Z",
  archivedAt: null,
}

const build: BuildkiteBuildForMirror = {
  id: "7d3a1c2e-build",
  number: 42,
  url: "https://buildkite.com/acme/web-app/builds/42",
  state: "failed",
  branch: "feature/login",
  commit: "abc1234def5678",
  message: "Fix the login form\n\nThe submit button | was hidden.",
  createdAt: "2026-10-12T10:00:00.000Z",
  startedAt: "2026-10-12T10:00:05.000Z",
  finishedAt: "2026-10-12T10:07:00.000Z",
  creatorName: null,
  authorName: "Sam Rivera",
  pullRequest: { number: "17", repository: null },
  jobs: [
    {
      name: ":rspec: Unit [tests]",
      state: "failed",
      exitStatus: 1,
      softFailed: false,
      url: "https://buildkite.com/acme/web-app/builds/42#job-1",
    },
    {
      name: "Lint | format",
      state: "passed",
      exitStatus: 0,
      softFailed: false,
      url: null,
    },
    {
      name: "Flaky check",
      state: "failed",
      exitStatus: 2,
      softFailed: true,
      url: null,
    },
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

  it("renders the pipeline with an index of its builds", () => {
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
        'created_at: "2026-01-02T03:04:05.000Z"',
        "---",
        "",
        "# Web App",
        "",
        "Builds and deploys the web app.",
        "",
        "- Buildkite: [Web App](https://buildkite.com/acme/web-app)",
        "- Repository: git@github.com:acme/web-app.git",
        "- Default branch: main",
        "",
        "## Latest builds",
        "",
        "| Build | State | Branch | Commit | Finished |",
        "| --- | --- | --- | --- | --- |",
        "| [#42](builds/42.md) | failed | feature/login | abc1234 | 2026-10-12T10:07:00.000Z |",
        "",
      ].join("\n"),
    )
  })

  it("renders a build with its GitHub links and failed jobs", () => {
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
        'started_at: "2026-10-12T10:00:05.000Z"',
        'finished_at: "2026-10-12T10:07:00.000Z"',
        "---",
        "",
        "# Web App build #42: Fix the login form",
        "",
        "- Pipeline: [Web App](../pipeline.md)",
        "- Buildkite: [#42](https://buildkite.com/acme/web-app/builds/42)",
        "- State: failed",
        "- Branch: feature/login",
        "- Commit: [abc1234](https://github.com/acme/web-app/commit/abc1234def5678)",
        "- Pull request: [#17](https://github.com/acme/web-app/pull/17)",
        "- Author: Sam Rivera",
        "- Started: 2026-10-12T10:00:05.000Z",
        "- Finished: 2026-10-12T10:07:00.000Z",
        "",
        "## Message",
        "",
        "Fix the login form\n\nThe submit button | was hidden.",
        "",
        "## Jobs",
        "",
        "2 of 3 jobs failed: :rspec: Unit [tests], Flaky check.",
        "",
        "| Job | State | Exit status |",
        "| --- | --- | --- |",
        "| [:rspec: Unit \\[tests\\]](https://buildkite.com/acme/web-app/builds/42#job-1) | failed | 1 |",
        "| Lint \\| format | passed | 0 |",
        "| Flaky check | failed (soft fail) | 2 |",
        "",
      ].join("\n"),
    )
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

  it("says when a pipeline has no finished builds", () => {
    const [pipelineFile] = buildkitePipelineFiles({
      organizationSlug: "acme",
      pipeline,
      builds: [],
    })
    expect(pipelineFile?.content).toContain("No finished builds.")
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
