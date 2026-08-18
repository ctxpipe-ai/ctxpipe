import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  RepositoryStatus,
  type RepositoryStatusState,
} from "./RepositoryStatus"

describe("RepositoryStatus", () => {
  it.each<RepositoryStatusState>([
    "queued",
    "running",
    "refreshing",
  ])("uses indexingDetail as the label for %s", (status) => {
    expect(
      renderToStaticMarkup(
        <RepositoryStatus status={status} indexingDetail="embedding 7/22" />,
      ),
    ).toContain("embedding 7/22")
  })

  it("ignores indexingDetail for non-active statuses", () => {
    expect(
      renderToStaticMarkup(
        <RepositoryStatus status="failed" indexingDetail="embedding 7/22" />,
      ),
    ).not.toContain("embedding 7/22")
  })

  it("appends relative time for ready when indexedAt is set", () => {
    const indexedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    expect(
      renderToStaticMarkup(
        <RepositoryStatus status="ready" indexedAt={indexedAt} />,
      ),
    ).toContain("indexed ·")
  })

  it("labels complete_with_issues and keeps the stored error for the tooltip", () => {
    const html = renderToStaticMarkup(
      <RepositoryStatus
        status="complete_with_issues"
        issuesDetail="Codebase didn't fit available memory"
        indexedAt={new Date(Date.now() - 60 * 60 * 1000).toISOString()}
      />,
    )
    expect(html).toContain("complete with issues")
    expect(html).toContain("ctx-indexing-issues")
  })
})
