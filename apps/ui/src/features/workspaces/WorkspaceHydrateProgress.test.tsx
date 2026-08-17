import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { WorkspaceHydrateProgress } from "./WorkspaceHydrateProgress"
import { failedHydrateWorkspace } from "./workspace-fixtures"

describe("WorkspaceHydrateProgress failed view", () => {
  it("names the failure and offers Try again without waiting copy", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <WorkspaceHydrateProgress
          orgSlug="acme"
          workspace={failedHydrateWorkspace}
        />
      </QueryClientProvider>,
    )
    expect(markup).toContain("Prepare failed")
    expect(markup).toContain("getLogger: no logger in context.")
    expect(markup).toContain("Try again")
    expect(markup).not.toContain("Waiting for a resolved tip.")
    expect(markup).not.toContain("animate-ping")
  })
})
