import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { WorkspaceDetail } from "./types"
import { WorkspacePaneTriggers } from "./WorkspacePane"
import { docsWorkspaceDetail } from "./workspace-fixtures"

function render(graph: NonNullable<WorkspaceDetail["hydratePhases"]>["graph"]) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspacePaneTriggers
        orgSlug="acme"
        workspace={{
          ...docsWorkspaceDetail,
          hydratePhases: { graph, index: { kind: "ready" } },
        }}
        onOpen={() => {}}
      />
    </QueryClientProvider>,
  )
}

describe("WorkspacePaneTriggers graph phase", () => {
  it("marks the Graph trigger while the graph phase is pending", () => {
    expect(render({ kind: "pending" })).toContain(
      'aria-label="Graph, building"',
    )
  })

  it("shows a plain Graph trigger once the graph phase is ready", () => {
    const markup = render({ kind: "ready" })
    expect(markup).toContain('aria-label="Graph"')
    expect(markup).not.toContain("building")
  })
})
