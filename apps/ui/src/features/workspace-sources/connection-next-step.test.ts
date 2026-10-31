import { describe, expect, it } from "vitest"

import { connectionNextStep } from "./connection-next-step"
import type { ConnectionUsageItem, PendingSourceChange } from "./queries"

function item(
  overrides: Partial<ConnectionUsageItem> & {
    workspaceSlug: string
    workspaceName: string
  },
): ConnectionUsageItem {
  return {
    workspaceId: `ws_${overrides.workspaceSlug}`,
    stat: "",
    sources: [],
    pendingChanges: [],
    ...overrides,
  }
}

function change(
  pullRequestUrl: string,
  overrides: Partial<PendingSourceChange> = {},
): PendingSourceChange {
  return {
    path: "sources/notion/notion.md",
    provider: "notion",
    action: "add",
    pullRequestUrl,
    createdAt: "2026-10-28T10:00:00.000Z",
    ...overrides,
  }
}

const okSource = {
  path: "sources/notion/notion.md",
  provider: "notion" as const,
  status: "ok" as const,
  scopeSummary: "2 pages",
}

describe("connectionNextStep", () => {
  it("asks to add the connection to a Workspace when no Workspace uses it", () => {
    expect(connectionNextStep({ items: [] })).toEqual({
      kind: "add_to_workspace",
    })
  })

  it("asks to merge when each Workspace only waits for a source pull request", () => {
    expect(
      connectionNextStep({
        items: [
          item({
            workspaceSlug: "docs",
            workspaceName: "Docs",
            pendingChanges: [change("https://github.com/acme/docs/pull/7")],
          }),
          item({
            workspaceSlug: "eng",
            workspaceName: "Engineering",
            pendingChanges: [change("https://github.com/acme/eng/pull/3")],
          }),
        ],
      }),
    ).toEqual({
      kind: "merge",
      pullRequests: [
        { url: "https://github.com/acme/docs/pull/7", workspaceName: "Docs" },
        {
          url: "https://github.com/acme/eng/pull/3",
          workspaceName: "Engineering",
        },
      ],
    })
  })

  it("names a pull request once when it holds several source changes", () => {
    const url = "https://github.com/acme/docs/pull/7"
    expect(
      connectionNextStep({
        items: [
          item({
            workspaceSlug: "docs",
            workspaceName: "Docs",
            pendingChanges: [
              change(url),
              change(url, { path: "sources/notion/notion-2.md" }),
            ],
          }),
        ],
      }),
    ).toEqual({ kind: "merge", pullRequests: [{ url, workspaceName: "Docs" }] })
  })

  it("asks to merge when the only source of a Workspace has a problem and a pull request waits", () => {
    expect(
      connectionNextStep({
        items: [
          item({
            workspaceSlug: "docs",
            workspaceName: "Docs",
            sources: [{ ...okSource, status: "invalid" }],
            pendingChanges: [
              change("https://github.com/acme/docs/pull/8", {
                action: "edit",
              }),
            ],
          }),
        ],
      }).kind,
    ).toBe("merge")
  })

  it("is live when a source syncs, also while another Workspace waits for a merge", () => {
    expect(
      connectionNextStep({
        items: [
          item({
            workspaceSlug: "docs",
            workspaceName: "Docs",
            sources: [okSource],
          }),
          item({
            workspaceSlug: "eng",
            workspaceName: "Engineering",
            pendingChanges: [change("https://github.com/acme/eng/pull/3")],
          }),
        ],
      }),
    ).toEqual({ kind: "live" })
  })

  it("is live when an edit waits for its merge on a source that syncs", () => {
    expect(
      connectionNextStep({
        items: [
          item({
            workspaceSlug: "docs",
            workspaceName: "Docs",
            sources: [okSource],
            pendingChanges: [
              change("https://github.com/acme/docs/pull/9", {
                action: "edit",
              }),
            ],
          }),
        ],
      }).kind,
    ).toBe("live")
  })

  it("is live for a GitHub Workspace repository that has no source file", () => {
    expect(
      connectionNextStep({
        items: [
          item({
            workspaceSlug: "docs",
            workspaceName: "Docs",
            stat: "Workspace repository",
          }),
        ],
      }).kind,
    ).toBe("live")
  })
})
