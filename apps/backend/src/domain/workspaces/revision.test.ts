import { describe, expect, it } from "vitest"
import {
  sameWorkspaceBinding,
  type WorkspaceRevision,
  workspaceRevisionSchema,
} from "./revision.js"

const revision: WorkspaceRevision = {
  workspaceId: "ws_alpha",
  generation: 2,
  remote: { url: "https://github.com/example-org/context", connectionId: null },
  defaultBranch: "main",
  sha: "a".repeat(40),
  access: "read",
}

describe("workspace revision root folder", () => {
  it("reads a stored revision without a root folder as the repository root", () => {
    expect(
      sameWorkspaceBinding(workspaceRevisionSchema.parse(revision), {
        ...revision,
        rootPath: "",
      }),
    ).toBe(true)
  })

  it("is another binding when the root folder differs", () => {
    expect(
      sameWorkspaceBinding(revision, { ...revision, rootPath: "docs/context" }),
    ).toBe(false)
  })

  it("rejects an unsafe root folder", () => {
    expect(
      workspaceRevisionSchema.safeParse({ ...revision, rootPath: "../x" })
        .success,
    ).toBe(false)
  })
})
