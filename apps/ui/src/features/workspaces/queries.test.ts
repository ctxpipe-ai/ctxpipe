import { describe, expect, it } from "vitest"
import { landingWorkspace } from "./queries"
import type { Workspace, WorkspaceListResponse } from "./types"

function ws(id: string, slug: string): Workspace {
  return {
    id,
    orgId: "org_1",
    slug,
    displayName: slug,
    workspaceRepositoryUrl: `https://github.com/acme/${slug}`,
    githubConnectionId: null,
    desiredGeneration: 1,
    desiredSha: null,
    activeProjectionUrl: null,
    activeProjectionSha: null,
    indexedSha: null,
    writeStatus: "unknown",
    hydrateStatus: "pending",
    readOnlyReason: null,
    mostRecentConversationId: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  }
}

describe("landingWorkspace", () => {
  it("returns null when the org has none", () => {
    const list: WorkspaceListResponse = {
      lastUsedWorkspaceId: null,
      items: [],
    }
    expect(landingWorkspace(list)).toBeNull()
  })

  it("prefers last-used when it still exists", () => {
    const a = ws("ws_a", "alpha")
    const b = ws("ws_b", "beta")
    expect(
      landingWorkspace({ lastUsedWorkspaceId: "ws_b", items: [a, b] })?.slug,
    ).toBe("beta")
  })

  it("falls back to the first Workspace when last-used is gone", () => {
    const a = ws("ws_a", "alpha")
    expect(
      landingWorkspace({ lastUsedWorkspaceId: "ws_missing", items: [a] })?.slug,
    ).toBe("alpha")
  })
})
