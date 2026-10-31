import { describe, expect, it } from "vitest"

import type { OrgConnectionListItem } from "../queries/org-connections"
import {
  catalogRows,
  catalogViews,
  rowsInView,
  sortOrgConnectionsForDisplay,
  statusChip,
} from "./catalog-state"
import { CONNECTOR_GROUPS, CONNECTOR_REGISTRY } from "./registry"

function connection(
  id: string,
  type: OrgConnectionListItem["type"],
  status: OrgConnectionListItem["status"],
): OrgConnectionListItem {
  return {
    id,
    type,
    displayName: null,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

function rowOf(connections: OrgConnectionListItem[], name: string) {
  const row = catalogRows(connections).find((item) => item.entry.name === name)
  if (!row) throw new Error(`No catalog row named ${name}`)
  return row
}

function availableRow(connections: OrgConnectionListItem[], name: string) {
  const row = rowOf(connections, name)
  if (row.kind !== "available") throw new Error(`${name} is not available`)
  return row
}

describe("the state of a provider", () => {
  it("shows the worst state first and points Fix at that connection", () => {
    const connections = [
      connection("con_li_ok", "linear", "connected"),
      connection("con_li_draft", "linear", "setup_pending"),
      connection("con_li_revoked", "linear", "needs_reconnect"),
    ]
    const row = availableRow(connections, "Linear")
    expect(row).toMatchObject({
      kind: "available",
      count: 3,
      status: "needs_reconnect",
      fixConnectionId: "con_li_revoked",
    })
    expect(statusChip(row)).toEqual({ health: "reconnect" })
  })

  it("puts an unfinished setup before connected", () => {
    const connections = [
      connection("con_no_ok", "notion", "connected"),
      connection("con_no_draft", "notion", "setup_pending"),
    ]
    const row = availableRow(connections, "Notion")
    expect(row).toMatchObject({
      status: "setup_pending",
      fixConnectionId: "con_no_draft",
    })
    expect(statusChip(row)).toEqual({ health: "setup_pending" })
  })

  it("counts the connections when more than one is connected", () => {
    const connections = [
      connection("con_gh_1", "github", "connected"),
      connection("con_gh_2", "github", "connected"),
      connection("con_sl", "slack", "connected"),
    ]
    expect(statusChip(availableRow(connections, "GitHub"))).toEqual({
      health: "connected",
      label: "2 connected",
    })
    expect(statusChip(availableRow(connections, "Slack"))).toEqual({
      health: "connected",
    })
    expect(availableRow(connections, "Slack")).toMatchObject({
      fixConnectionId: null,
    })
  })

  it("gives no chip to a provider with no connection, and marks a planned one", () => {
    expect(statusChip(availableRow([], "Plain"))).toBeNull()
    expect(rowOf([], "Zendesk").kind).toBe("coming_soon")
  })

  it("reads a Forge connection as Confluence", () => {
    const connections = [connection("con_cf", "forge", "connected")]
    expect(availableRow(connections, "Confluence")).toMatchObject({
      count: 1,
    })
  })
})

describe("the views of the catalog", () => {
  const connections = [
    connection("con_gh", "github", "connected"),
    connection("con_li", "linear", "setup_pending"),
  ]

  it("counts the connectors in each view", () => {
    const soon = CONNECTOR_REGISTRY.filter(
      (entry) => entry.availability === "coming_soon",
    )
    expect(
      catalogViews(catalogRows(connections)).map(
        (view) => `${view.name} ${view.count}`,
      ),
    ).toEqual([
      `All ${CONNECTOR_REGISTRY.length}`,
      "Connected 2",
      ...CONNECTOR_GROUPS.map(
        (group) =>
          `${group.name} ${
            CONNECTOR_REGISTRY.filter((entry) => entry.group === group.id)
              .length
          }`,
      ),
      `Coming soon ${soon.length}`,
    ])
  })

  it("lists the rows of a view", () => {
    const rows = catalogRows(connections)
    const names = (view: Parameters<typeof rowsInView>[1], query = "") =>
      rowsInView(rows, view, query).map((row) => row.entry.name)
    expect(names("connected")).toEqual(["GitHub", "Linear"])
    expect(names("support")).toEqual(
      CONNECTOR_REGISTRY.filter((entry) => entry.group === "support").map(
        (entry) => entry.name,
      ),
    )
    expect(names("coming_soon")).toEqual(
      CONNECTOR_REGISTRY.filter(
        (entry) => entry.availability === "coming_soon",
      ).map((entry) => entry.name),
    )
  })

  it("searches the name, the description, and the group of every view", () => {
    const rows = catalogRows(connections)
    const names = (query: string) =>
      rowsInView(rows, "work", query).map((row) => row.entry.name)
    expect(names("  PAGER ")).toEqual(["PagerDuty"])
    expect(names("incidents")).toEqual(["PagerDuty"])
    expect(names("support")).toEqual(["Plain", "Zendesk"])
    expect(names("no such tool")).toEqual([])
  })
})

describe("the order of the connection cards", () => {
  const row = (type: OrgConnectionListItem["type"], createdAt: string) => ({
    ...connection(`con_${type}_${createdAt}`, type, "connected"),
    createdAt,
  })

  it("puts GitHub first even when it was added later, then the catalog order", () => {
    expect(
      sortOrgConnectionsForDisplay([
        row("notion", "2026-01-01T00:00:00.000Z"),
        row("forge", "2026-01-02T00:00:00.000Z"),
        row("github", "2026-06-01T00:00:00.000Z"),
        row("linear", "2026-01-03T00:00:00.000Z"),
        row("pagerduty", "2026-01-01T00:00:00.000Z"),
        row("slack", "2026-01-01T00:00:00.000Z"),
      ]).map((item) => item.type),
    ).toEqual(["github", "forge", "notion", "linear", "slack", "pagerduty"])
  })
})
