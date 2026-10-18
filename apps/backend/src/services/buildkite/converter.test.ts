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

  it("keeps a pipeline slug from leaving its folder", () => {
    const paths = buildkitePipelineFiles({
      organizationSlug: "acme",
      pipeline: { ...pipeline, slug: "../../.ctxpipe" },
      builds: [build],
    }).map((candidate) => candidate.path)

    expect(paths).toEqual([
      "buildkite/pipelines/-.-..-.ctxpipe/pipeline.md",
      "buildkite/pipelines/-.-..-.ctxpipe/builds/42.md",
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
        "- Deploy \\| prod (timed out)",
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

  it("keeps provider text on one line and links only https URLs", () => {
    const [pipelineFile, buildFile] = buildkitePipelineFiles({
      organizationSlug: "acme",
      pipeline: { ...pipeline, name: "Web\n# Injected heading" },
      builds: [
        {
          ...build,
          url: "javascript:alert(1)",
          branch: "main\n\n## Injected section",
          commit: "abc1234)(https://evil.example",
          creatorName: "Sam\n- injected item",
          jobs: [
            {
              name: "Unit\n```",
              state: "failed",
              softFailed: false,
              url: "https://buildkite.com/acme/web-app/builds/42#job-(1)",
            },
          ],
        },
      ],
    })
    const body = `${pipelineFile?.content}${buildFile?.content}`
    expect(body).not.toMatch(/^#+ Injected/m)
    expect(body).not.toMatch(/^- injected/m)
    expect(body).not.toMatch(/^```/m)
    expect(buildFile?.content).toContain("# Web \\# Injected heading build #42")
    expect(buildFile?.content).toContain("- Buildkite: #42\n")
    expect(buildFile?.content).toContain(
      "- Branch: main \\#\\# Injected section",
    )
    expect(buildFile?.content).not.toContain("commit_url")
    expect(buildFile?.content).toContain(
      "- [Unit \\`\\`\\`](https://buildkite.com/acme/web-app/builds/42#job-%281%29)",
    )
  })
})

describe("credentials in a git remote", () => {
  it.each([
    [
      "https://user:s3cret-token@git.example.com/org/repo.git",
      "https://git.example.com/org/repo.git",
    ],
    [
      "https://s3cret-token@git.example.com:8443/org/repo.git?x=s3cret-token#s3cret-token",
      "https://git.example.com:8443/org/repo.git",
    ],
    [
      "ssh://deploy:s3cret-token@git.example.com/org/repo.git",
      "ssh://git.example.com/org/repo.git",
    ],
    [
      "user:s3cret-token@git.example.com:org/repo.git",
      "git.example.com:org/repo.git",
    ],
  ])("keeps only the host and path of %s", (remote, expected) => {
    const files = buildkitePipelineFiles({
      organizationSlug: "acme",
      pipeline: { ...pipeline, repository: remote },
      builds: [build],
    })
    const [pipelineFile, buildFile] = files
    expect(pipelineFile?.content).toContain(`repository: "${expected}"`)
    expect(pipelineFile?.content).toContain(
      `- Repository: ${expected.replace(/[\\`*_[\]()!<>#|]/g, "\\$&")}`,
    )
    expect(files.map((file) => file.content).join("\n")).not.toContain(
      "s3cret-token",
    )
    expect(buildFile?.content).not.toContain("s3cret-token")
  })
})

describe("a git remote that does not parse cleanly", () => {
  it.each([
    "https://user:p4ss/w0rd@git.example.com/org/repo.git",
    "https://user:p4ss#w0rd@git.example.com/org/repo.git",
    "https://user:p4ss?w0rd@git.example.com/org/repo.git",
    "https://p4ss/w0rd@git.example.com/org/repo.git",
    "git.example.com/org/repo.git?token=p4ss-w0rd",
    "git.example.com/org/repo.git#p4ss-w0rd",
    "user:p4ss/w0rd@git.example.com:org/repo.git",
    "user:p4ss@w0rd@git.example.com:org/repo.git",
    "user:p4ss-w0rd@git.example.com/org/repo.git",
    "[x](https://p4ss-w0rd.example)",
  ])("does not write %s", (remote) => {
    const files = buildkitePipelineFiles({
      organizationSlug: "acme",
      pipeline: { ...pipeline, repository: remote },
      builds: [build],
    })
    const text = files.map((file) => file.content).join("\n")
    expect(text).not.toContain("repository:")
    expect(text).not.toContain("- Repository:")
    expect(text).not.toMatch(/p4ss|w0rd/)
  })

  it("still writes a bare host and path", () => {
    const [pipelineFile] = buildkitePipelineFiles({
      organizationSlug: "acme",
      pipeline: { ...pipeline, repository: "git.example.com/org/repo.git" },
      builds: [],
    })
    expect(pipelineFile?.content).toContain(
      'repository: "git.example.com/org/repo.git"',
    )
  })
})

describe("length of provider text", () => {
  it("cuts a long branch, job label, creator, and pipeline name to 200 characters", () => {
    const long = (prefix: string) => `${prefix}${"x".repeat(5_000)}`
    const [pipelineFile, buildFile] = buildkitePipelineFiles({
      organizationSlug: "acme",
      pipeline: { ...pipeline, name: long("name-") },
      builds: [
        {
          ...build,
          branch: long("branch-"),
          creatorName: long("creator-"),
          jobs: [{ ...build.jobs[0], name: long("job-") } as never],
        },
      ],
    })
    const text = `${pipelineFile?.content}${buildFile?.content}`
    expect(text).not.toContain("x".repeat(201))
    const cut = (prefix: string) =>
      `${prefix}${"x".repeat(200 - prefix.length)}…`
    expect(buildFile?.content).toContain(`branch: "${cut("branch-")}"`)
    expect(buildFile?.content).toContain(`- Branch: ${cut("branch-")}\n`)
    expect(buildFile?.content).toContain(`- Created by: ${cut("creator-")}\n`)
    expect(buildFile?.content).toContain(`- [${cut("job-")}](`)
    expect(pipelineFile?.content).toContain(`# ${cut("name-")}\n`)
  })

  it("does not cut a short value or a URL", () => {
    const url = `https://buildkite.com/acme/web-app/builds/42?${"q".repeat(300)}`
    const [, buildFile] = buildkitePipelineFiles({
      organizationSlug: "acme",
      pipeline,
      builds: [{ ...build, url }],
    })
    expect(buildFile?.content).toContain(`url: "${url}"`)
    expect(buildFile?.content).toContain('branch: "feature/login"')
  })
})

describe("control and format characters in provider text", () => {
  it("removes them from the front matter and the body", () => {
    const [pipelineFile, buildFile] = buildkitePipelineFiles({
      organizationSlug: "acme",
      pipeline: { ...pipeline, name: "Web‮App​\u0000" },
      builds: [
        {
          ...build,
          branch: "main⁦\u001b[31m",
          creatorName: "Sam‮ Rivera",
        },
      ],
    })
    const text = `${pipelineFile?.content}${buildFile?.content}`
    // Line feeds are the line ends of the files.
    expect(text.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}]/u)
    expect(pipelineFile?.content).toContain("# WebApp\n")
    expect(buildFile?.content).toContain('branch: "main[31m"')
    expect(buildFile?.content).toContain("- Created by: Sam Rivera")
  })
})

describe("Markdown in provider text", () => {
  const payloads = [
    "[x](https://evil.example)",
    "![](https://evil.example/pixel.png)",
    "<img src=x onerror=alert(1)>",
  ]
  const backslash = (value: string) =>
    value.replace(/[\\`*_[\]()!<>#|]/g, "\\$&")

  const fields: Array<
    [
      string,
      (payload: string) => {
        pipeline?: Partial<BuildkitePipelineForMirror>
        build?: Partial<BuildkiteBuildForMirror>
      },
    ]
  > = [
    ["pipeline name", (name) => ({ pipeline: { name } })],
    ["default branch", (defaultBranch) => ({ pipeline: { defaultBranch } })],
    ["state", (state) => ({ build: { state } })],
    ["branch", (branch) => ({ build: { branch } })],
    ["creator", (creatorName) => ({ build: { creatorName } })],
    ["commit", (commit) => ({ build: { commit } })],
    ["pull request", (pullRequestNumber) => ({ build: { pullRequestNumber } })],
    [
      "job name",
      (name) => ({
        build: { jobs: [{ ...build.jobs[0], name } as never] },
      }),
    ],
  ]

  it.each(
    fields,
  )("escapes a link, an image, and a tag in the %s", (_name, set) => {
    for (const payload of payloads) {
      const patch = set(payload)
      const files = buildkitePipelineFiles({
        organizationSlug: "acme",
        pipeline: { ...pipeline, ...patch.pipeline },
        builds: [{ ...build, ...patch.build }],
      })
      const text = files.map((file) => file.content).join("\n")
      // The front matter holds JSON strings. The body is Markdown.
      const body = files
        .map((file) => file.content.split("\n---\n").pop() ?? "")
        .join("\n")
      expect(body).not.toMatch(/(?<!\\)(\]\(https:\/\/evil|!\[|<img)/)
      expect(text).toContain(backslash(payload))
    }
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
