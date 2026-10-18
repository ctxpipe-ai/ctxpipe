import { describe, expect, it } from "vitest"
import {
  canonicalWorkspaceGitUrl,
  eligibleInstallationRepos,
  sameGitUrl,
} from "./gitUrl"

describe("canonicalWorkspaceGitUrl", () => {
  it("strips .git and a trailing slash", () => {
    expect(
      canonicalWorkspaceGitUrl("https://github.com/acme/knowledge.git/"),
    ).toBe("https://github.com/acme/knowledge")
  })
})

describe("sameGitUrl", () => {
  // GitHub names are not case-sensitive. The stored Workspace URL can be in
  // lowercase while the installation list keeps the letter case of GitHub.
  it("ignores the letter case, .git, and a trailing slash", () => {
    expect(
      sameGitUrl(
        "https://github.com/AcmeCo/Knowledge.git",
        "https://github.com/acmeco/knowledge/",
      ),
    ).toBe(true)
  })

  it("keeps two repositories apart", () => {
    expect(
      sameGitUrl(
        "https://github.com/acme/knowledge",
        "https://github.com/acme/knowledge-2",
      ),
    ).toBe(false)
  })
})

describe("eligibleInstallationRepos", () => {
  const repos = [
    { name: "knowledge", clone_url: "https://github.com/acme/knowledge.git" },
    { name: "docs", clone_url: "https://github.com/acme/docs.git" },
  ]

  it("hides URLs that already back another Workspace", () => {
    expect(
      eligibleInstallationRepos({
        repositories: repos,
        takenUrls: ["https://github.com/acme/knowledge"],
      }).map((repo) => repo.name),
    ).toEqual(["docs"])
  })

  it("hides the current workspace repository when relinking", () => {
    expect(
      eligibleInstallationRepos({
        repositories: repos,
        takenUrls: ["https://github.com/acme/knowledge"],
        currentUrl: "https://github.com/acme/docs",
      }).map((repo) => repo.name),
    ).toEqual([])
  })

  it("hides a taken URL that GitHub lists with other letter case", () => {
    expect(
      eligibleInstallationRepos({
        repositories: [
          {
            name: "Knowledge",
            clone_url: "https://github.com/AcmeCo/Knowledge.git",
          },
          ...repos,
        ],
        takenUrls: ["https://github.com/acmeco/knowledge"],
      }).map((repo) => repo.name),
    ).toEqual(["knowledge", "docs"])
  })

  it("keeps a URL that is only linked elsewhere, not backing a Workspace", () => {
    expect(
      eligibleInstallationRepos({
        repositories: repos,
        takenUrls: ["https://github.com/acme/other"],
      }).map((repo) => repo.name),
    ).toEqual(["knowledge", "docs"])
  })
})
