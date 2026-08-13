import { describe, expect, it } from "vitest"
import {
  type OrgConnectionListItem,
  sortOrgConnectionsForDisplay,
} from "./org-connections"

function row(
  type: OrgConnectionListItem["type"],
  createdAt: string,
): OrgConnectionListItem {
  return {
    id: `con_${type}_${createdAt}`,
    type,
    createdAt,
    updatedAt: createdAt,
  }
}

describe("sortOrgConnectionsForDisplay", () => {
  it("puts GitHub first even when it was added later", () => {
    expect(
      sortOrgConnectionsForDisplay([
        row("notion", "2026-01-01T00:00:00.000Z"),
        row("forge", "2026-01-02T00:00:00.000Z"),
        row("github", "2026-06-01T00:00:00.000Z"),
        row("linear", "2026-01-03T00:00:00.000Z"),
      ]).map((item) => item.type),
    ).toEqual(["github", "forge", "linear", "notion"])
  })
})
