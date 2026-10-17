import { describe, expect, it } from "vitest"
import type { ProjectionState, WorkspaceRevision } from "./revision.js"
import { servedSha } from "./tip-resolve.js"

const revision: WorkspaceRevision = {
  workspaceId: "ws_fixture",
  generation: 1,
  remote: { url: "https://github.com/fixture/context.git", connectionId: null },
  defaultBranch: "main",
  sha: "a".repeat(40),
  access: "read",
}
const ready = { kind: "ready" } as const
const active = (served: WorkspaceRevision): ProjectionState => ({
  kind: "active",
  revision: served,
  stores: { embeddings: ready, graph: ready, index: ready },
})

describe("servedSha", () => {
  it("returns the SHA of a legacy projection", () => {
    expect(
      servedSha(
        {
          kind: "building",
          desired: revision,
          previous: { kind: "legacy", url: null, sha: "b".repeat(40) },
        },
        revision,
      ),
    ).toBe("b".repeat(40))
  })

  it("returns the active SHA for the same binding", () => {
    expect(
      servedSha(active({ ...revision, sha: "c".repeat(40) }), revision),
    ).toBe("c".repeat(40))
  })

  it("returns null when the active binding is different", () => {
    expect(
      servedSha(active({ ...revision, defaultBranch: "trunk" }), revision),
    ).toBeNull()
    expect(
      servedSha(active({ ...revision, generation: 2 }), revision),
    ).toBeNull()
  })

  it("returns null before the first published projection", () => {
    expect(
      servedSha(
        { kind: "building", desired: revision, previous: null },
        revision,
      ),
    ).toBeNull()
  })
})
