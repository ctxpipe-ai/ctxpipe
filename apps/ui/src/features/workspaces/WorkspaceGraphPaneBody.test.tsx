import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { WorkspaceDetail } from "./types"
import { WorkspaceGraphPaneBody } from "./WorkspacePane"
import { docsWorkspaceDetail } from "./workspace-fixtures"

function render(graph: NonNullable<WorkspaceDetail["hydratePhases"]>["graph"]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <WorkspaceGraphPaneBody
        orgSlug="acme"
        workspace={{
          ...docsWorkspaceDetail,
          hydratePhases: { graph, index: { kind: "pending" } },
        }}
      />
    </QueryClientProvider>,
  )
}

describe("WorkspaceGraphPaneBody graph phase", () => {
  it("shows a building state while the graph phase is pending", () => {
    const markup = render({ kind: "pending" })
    expect(markup).toContain("Building graph")
    expect(markup).not.toContain("Could not load graph")
  })

  it("shows the failure message when the graph phase failed", () => {
    const markup = render({
      kind: "failed",
      message: "graph store refused the write",
    })
    expect(markup).toContain("Could not build graph")
    expect(markup).toContain("graph store refused the write")
  })
})
