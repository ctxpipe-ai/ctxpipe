import { describe, expect, it } from "vitest"
import { gitSourcePath } from "../source-file.js"
import { parseSourceFile } from "../source-file-text.js"
import {
  checkPlainGitUrl,
  gitSourceScopeUrl,
  plainGitUrlPolicy,
  sourceRepositoryName,
  sourceRepositoryUrls,
} from "./git.js"

describe("checkPlainGitUrl", () => {
  it("accepts a public HTTPS git URL and gives its checked form", () => {
    expect(checkPlainGitUrl("https://Git.Example.org/team/app.git/")).toEqual({
      ok: true,
      url: "https://git.example.org/team/app.git",
      host: "git.example.org",
      port: 443,
      path: "/team/app.git",
    })
    expect(checkPlainGitUrl("https://github.com/octocat/Hello-World")).toEqual(
      expect.objectContaining({ ok: true, path: "/octocat/Hello-World" }),
    )
  })

  it.each([
    ["not_a_url", "git.example.org/team/app.git"],
    ["not_https", "http://git.example.org/team/app.git"],
    ["not_https", "ssh://git@git.example.org/team/app.git"],
    ["not_https", "git://git.example.org/team/app.git"],
    ["not_https", "file:///srv/team/app.git"],
    ["userinfo", "https://token@git.example.org/team/app.git"],
    ["userinfo", "https://user:secret@git.example.org/team/app.git"],
    ["port", "https://git.example.org:8443/team/app.git"],
    ["port", "https://git.example.org:22/team/app.git"],
    ["query", "https://git.example.org/team/app.git?ref=main"],
    ["query", "https://git.example.org/team/app.git#main"],
    ["ip_address", "https://10.0.0.5/team/app.git"],
    ["ip_address", "https://127.0.0.1/team/app.git"],
    ["ip_address", "https://169.254.169.254/latest/meta-data"],
    ["ip_address", "https://0x7f.1/team/app.git"],
    ["ip_address", "https://2130706433/team/app.git"],
    ["ip_address", "https://[::1]/team/app.git"],
    ["ip_address", "https://[fd00:ec2::254]/team/app.git"],
    ["ip_address", "https://93.184.215.14/team/app.git"],
    ["private_host", "https://localhost/team/app.git"],
    ["private_host", "https://git.localhost/team/app.git"],
    ["private_host", "https://metadata.google.internal/computeMetadata"],
    ["private_host", "https://gitserver/team/app.git"],
    ["private_host", "https://git.corp/team/app.git"],
    ["private_host", "https://nas.local/team/app.git"],
    ["private_host", "https://1.0.0.10.in-addr.arpa/team/app.git"],
    ["path", "https://git.example.org/"],
    ["path", "https://git.example.org/team/%2e%2e/app.git"],
    ["path", "https://git.example.org/team/app%20x.git"],
    ["path", "https://git.example.org/team//app.git"],
  ] as const)("refuses %s: %s", (rule, url) => {
    expect(checkPlainGitUrl(url)).toEqual(
      expect.objectContaining({ ok: false, rule }),
    )
  })

  it.each([
    "git://git.example.org/team/app.git",
    "ssh://git@git.example.org/team/app.git",
    "git@git.example.org:team/app.git",
    "file:///srv/team/app.git",
  ])("names the scheme rule when it refuses %s", (url) => {
    const checked = checkPlainGitUrl(url)
    expect(checked.ok).toBe(false)
    if (checked.ok) return
    expect(checked.reason).toContain(
      "Plain git sources must use an https:// URL. ssh (git@… or ssh://), git:// and file:// are not supported.",
    )
  })

  it("has the same strict policy in each deployment mode until a product decision changes it", () => {
    for (const mode of ["hosted", "self-host"] as const)
      expect(plainGitUrlPolicy(mode), mode).toEqual({
        http: false,
        otherPorts: false,
        privateHosts: false,
      })
  })
})

describe("a plain git source file", () => {
  it("has a URL and no connection", () => {
    const parsed = parseSourceFile(
      "sources/git/git.example.org/team-app.md",
      "---\nprovider: git\nurl: https://git.example.org/team/app.git\n---\nThe tools.\n",
    )
    expect(parsed).toEqual({
      ok: true,
      source: {
        path: "sources/git/git.example.org/team-app.md",
        provider: "git",
        connectionId: null,
        scope: { url: "https://git.example.org/team/app.git" },
      },
      body: "The tools.\n",
    })
  })

  it("refuses a connection, a URL that ctx| does not read, and another key", () => {
    const parse = (frontMatter: string) =>
      parseSourceFile(
        "sources/git/git.example.org/team-app.md",
        `---\nprovider: git\n${frontMatter}\n---\n`,
      )
    expect(
      parse("connection: con_abc\nurl: https://git.example.org/team/app.git"),
    ).toMatchObject({
      ok: false,
      detail: "connection: a plain git source has no connection",
    })
    expect(parse("url: http://git.example.org/team/app.git")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("must use an https:// URL"),
    })
    expect(
      parse("url: https://git.example.org/team/app.git\nref: main"),
    ).toMatchObject({ ok: false })
  })

  it("gets a path from its host and repository path", () => {
    expect(gitSourcePath("https://Git.Example.org/team/app.git")).toBe(
      "sources/git/git.example.org/team-app.md",
    )
    expect(
      gitSourcePath(
        "https://git.example.org/team/app",
        new Set(["sources/git/git.example.org/team-app.md"]),
      ),
    ).toBe("sources/git/git.example.org/team-app-2.md")
    expect(gitSourcePath("http://git.example.org/team/app.git")).toBeNull()
  })
})

describe("the repository of a plain git source", () => {
  it("has the checked URL, a normalized key, and a name", () => {
    const scope = { url: "https://Git.Example.org/team/app.git/" }
    expect(gitSourceScopeUrl(scope)).toBe(
      "https://git.example.org/team/app.git",
    )
    expect(sourceRepositoryUrls({ provider: "git", scope })).toEqual([
      "https://git.example.org/team/app",
    ])
    expect(sourceRepositoryName("https://git.example.org/team/app.git")).toBe(
      "git.example.org/team/app",
    )
    expect(sourceRepositoryName("https://github.com/Acme/Web.git")).toBe(
      "acme/web",
    )
  })
})
