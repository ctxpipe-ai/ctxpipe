import { describe, expect, it } from "vitest"
import { canonicalWorkspaceGitUrl, eligibleInstallationRepos } from "./gitUrl"

describe("canonicalWorkspaceGitUrl", () => {
  it("strips .git and a trailing slash", () => {
    expect(
      canonicalWorkspaceGitUrl("https://github.com/acme/knowledge.git/"),
    ).toBe("https://github.com/acme/knowledge")
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

  it("keeps a URL that is only linked elsewhere, not backing a Workspace", () => {
    expect(
      eligibleInstallationRepos({
        repositories: repos,
        takenUrls: ["https://github.com/acme/other"],
      }).map((repo) => repo.name),
    ).toEqual(["knowledge", "docs"])
  })
})
