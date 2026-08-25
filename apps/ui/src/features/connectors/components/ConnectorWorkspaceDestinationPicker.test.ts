import { describe, expect, it } from "vitest"
import { docsWorkspace, readOnlyWorkspace } from "@/features/workspaces/workspace-fixtures"
import {
  destinationFromWorkspace,
  normalizeWorkspaceGitUrl,
  workspaceMatchingGitUrl,
} from "./ConnectorWorkspaceDestinationPicker"

describe("destinationFromWorkspace", () => {
  it("resolves repo identity from the workspace remote", () => {
    expect(destinationFromWorkspace(docsWorkspace)).toEqual({
      workspace: docsWorkspace,
      gitUrl: "https://github.com/acme/docs",
      repositoryName: "acme/docs",
      githubConnectionId: "con_1",
      branch: "main",
    })
  })
})

describe("workspaceMatchingGitUrl", () => {
  it("matches a workspace by canonical clone URL", () => {
    expect(
      workspaceMatchingGitUrl(
        [docsWorkspace, readOnlyWorkspace],
        "https://github.com/acme/docs.git",
      )?.id,
    ).toBe(docsWorkspace.id)
  })

  it("returns null when no workspace owns that remote", () => {
    expect(
      workspaceMatchingGitUrl([docsWorkspace], "https://github.com/acme/other"),
    ).toBeNull()
  })
})

describe("normalizeWorkspaceGitUrl", () => {
  it("drops .git and case", () => {
    expect(normalizeWorkspaceGitUrl("https://GitHub.com/Acme/Docs.git")).toBe(
      "https://github.com/acme/docs",
    )
  })
})
