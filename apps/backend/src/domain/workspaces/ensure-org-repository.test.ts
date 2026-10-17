import { describe, expect, it } from "vitest"
import { repositoryNameFromGitUrl } from "./ensure-org-repository.js"

describe("repositoryNameFromGitUrl", () => {
  it("uses owner/repo for GitHub URLs", () => {
    expect(repositoryNameFromGitUrl("https://github.com/acme/docs.git")).toBe(
      "acme/docs",
    )
  })

  it("uses host plus path for other hosts so names stay unique per org", () => {
    expect(
      repositoryNameFromGitUrl("https://gitlab.com/acme/group/app.git"),
    ).toBe("gitlab.com/acme/group/app")
    expect(repositoryNameFromGitUrl("https://gitlab.com/other/app.git")).toBe(
      "gitlab.com/other/app",
    )
    expect(
      repositoryNameFromGitUrl("https://git.example:8443/acme/app.git"),
    ).toBe("git.example:8443/acme/app")
  })
})
