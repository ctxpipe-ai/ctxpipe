import { QueryClient } from "@tanstack/react-query"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { ensureWorkspaceRouteData } from "./ensure-route-data"
import { docsWorkspaceDetail, hydratingWorkspace } from "./workspace-fixtures"

const hydratingWorkspaceDetail = {
  ...hydratingWorkspace,
  linkedRepositories: [],
}

const server = setupServer()
let treeHits = 0
let blobHits = 0

function listenForWorkspaceHttp() {
  server.use(
    http.get(
      "http://localhost:3000/:orgSlug/api/v1/workspaces/:workspaceSlug/files/tree",
      () => {
        treeHits += 1
        return HttpResponse.json({ sha: "abc123def456", paths: ["AGENTS.md"] })
      },
    ),
    http.get(
      "http://localhost:3000/:orgSlug/api/v1/workspaces/:workspaceSlug/files/blob",
      () => {
        blobHits += 1
        return HttpResponse.json({
          path: "AGENTS.md",
          body: "# Agents",
          binary: false,
        })
      },
    ),
    http.get(
      "http://localhost:3000/:orgSlug/api/v1/workspaces/:workspaceSlug",
      ({ params }) => {
        if (params.workspaceSlug === hydratingWorkspace.slug) {
          return HttpResponse.json(hydratingWorkspaceDetail)
        }
        return HttpResponse.json(docsWorkspaceDetail)
      },
    ),
  )
}

describe("ensureWorkspaceRouteData", () => {
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
  afterEach(() => {
    server.resetHandlers()
    treeHits = 0
    blobHits = 0
  })
  afterAll(() => {
    server.close()
  })

  it("does not fetch files/tree when the workspace is not projection-ready", async () => {
    listenForWorkspaceHttp()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    await ensureWorkspaceRouteData({
      queryClient,
      orgSlug: "acme",
      workspaceSlug: hydratingWorkspace.slug,
      warmLandingPane: true,
    })
    expect(treeHits).toBe(0)
  })

  it("fetches files/tree when the workspace is projection-ready", async () => {
    listenForWorkspaceHttp()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    await ensureWorkspaceRouteData({
      queryClient,
      orgSlug: "acme",
      workspaceSlug: docsWorkspaceDetail.slug,
      warmLandingPane: true,
    })
    expect(treeHits).toBe(1)
  })

  it("does not fetch files/tree or blob when pane warmup is skipped", async () => {
    listenForWorkspaceHttp()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    await ensureWorkspaceRouteData({
      queryClient,
      orgSlug: "acme",
      workspaceSlug: docsWorkspaceDetail.slug,
      paneParam: "file:AGENTS.md",
      warmLandingPane: false,
    })
    expect(treeHits).toBe(0)
    expect(blobHits).toBe(0)
  })
})
