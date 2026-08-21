import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  deleteWorkspace,
  landingWorkspace,
  retryPrepareWorkspace,
} from "./queries"
import type { Workspace, WorkspaceListResponse } from "./types"
import { failedHydrateWorkspace } from "./workspace-fixtures"

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
    hydrateError: null,
    readOnlyReason: null,
    mostRecentConversationId: null,
    migrationExportSha: null,
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

const server = setupServer()

describe("workspace query HTTP helpers", () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" })
    const intercepted = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const next =
        typeof input === "string" && input.startsWith("/")
          ? `http://localhost${input}`
          : input
      return intercepted(next as RequestInfo, init)
    }) as typeof fetch
  })
  afterEach(() => server.resetHandlers())
  afterAll(() => {
    server.close()
  })

  it("returns pending after a successful retry", async () => {
    server.use(
      http.post(
        "http://localhost:3000/:orgSlug/api/v1/workspaces/:workspaceSlug/retry-prepare",
        () =>
          HttpResponse.json({
            ...failedHydrateWorkspace,
            hydrateStatus: "pending",
            hydrateError: null,
          }),
      ),
    )
    const result = await retryPrepareWorkspace("acme", "knowledge-failed")
    expect(result.hydrateStatus).toBe("pending")
    expect(result.hydrateError).toBeNull()
  })

  it("surfaces evlog { message } when { error } is absent", async () => {
    server.use(
      http.delete(
        "http://localhost:3000/:orgSlug/api/v1/workspaces/:workspaceSlug",
        () =>
          HttpResponse.json(
            { message: "Connection terminated unexpectedly" },
            { status: 500 },
          ),
      ),
    )
    await expect(deleteWorkspace("acme", "docs", "Docs")).rejects.toThrow(
      "Connection terminated unexpectedly",
    )
  })

  it("prefers { error } over { message } for delete failures", async () => {
    server.use(
      http.delete(
        "http://localhost:3000/:orgSlug/api/v1/workspaces/:workspaceSlug",
        () =>
          HttpResponse.json(
            {
              error: "Type the Workspace display name to confirm delete",
              message: "Bad Request",
            },
            { status: 400 },
          ),
      ),
    )
    await expect(deleteWorkspace("acme", "docs", "wrong")).rejects.toThrow(
      "Type the Workspace display name to confirm delete",
    )
  })
})
