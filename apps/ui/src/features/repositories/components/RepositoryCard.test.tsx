import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { Repository } from "../types"
import { RepositoryCard } from "./RepositoryCard"

const memoryError = "Codebase didn't fit available memory"

const baseRepo: Repository = {
  id: "repo_1",
  orgId: "org_acme",
  zoektRepoId: 1,
  name: "acme/web",
  gitUrl: "https://github.com/acme/web.git",
  indexReady: true,
  indexingStatus: "ready",
  indexingError: null,
  indexingFailedAt: null,
  indexingReason: null,
  indexingStep: null,
  indexingStepTotal: null,
  indexingStepKey: null,
  lastIngestedHash: "abc1234",
  lastIngestedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  githubConnectionId: null,
}

describe("RepositoryCard", () => {
  it("shows complete with issues and the stored memory-fit error", () => {
    const html = renderToStaticMarkup(
      <RepositoryCard
        repo={{
          ...baseRepo,
          indexingStatus: "complete_with_issues",
          indexingError: memoryError,
        }}
        onDelete={vi.fn()}
        onRetry={vi.fn()}
        interactive={false}
      />,
    )
    expect(html).toContain("complete with issues")
    expect(html).toContain("sr-only")
    expect(html).toContain("Codebase didn&#x27;t fit available memory")
    expect(html).toContain("ctx-indexing-issues")
  })

  it("shows out of date with the memory-fit error after a prior-success task OOM", () => {
    const html = renderToStaticMarkup(
      <RepositoryCard
        repo={{
          ...baseRepo,
          indexReady: false,
          indexingStatus: "failed",
          indexingError: memoryError,
        }}
        onDelete={vi.fn()}
        onRetry={vi.fn()}
        interactive={false}
      />,
    )
    expect(html).toContain("out of date")
    expect(html).toContain("Codebase didn&#x27;t fit available memory")
  })
})
