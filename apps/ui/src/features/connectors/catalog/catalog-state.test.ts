import { describe, expect, it } from "vitest"

import type { OrgConnectionListItem } from "../queries/org-connections"
import {
  catalogRows,
  catalogViews,
  rowsInView,
  statusLabel,
} from "./catalog-state"

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

describe("the state of a provider", () => {
  it("shows the worst state first and points Fix at that connection", () => {
    const connections = [
      connection("con_li_ok", "linear", "connected"),
      connection("con_li_draft", "linear", "setup_pending"),
      connection("con_li_revoked", "linear", "needs_reconnect"),
    ]
    expect(rowOf(connections, "Linear").state).toEqual({
      kind: "available",
      count: 3,
      status: "needs_reconnect",
      fixConnectionId: "con_li_revoked",
    })
    expect(statusLabel(rowOf(connections, "Linear").state)).toBe(
      "Needs reconnect",
    )
  })

  it("puts an unfinished setup before connected", () => {
    const connections = [
      connection("con_no_ok", "notion", "connected"),
      connection("con_no_draft", "notion", "setup_pending"),
    ]
    const { state } = rowOf(connections, "Notion")
    expect(state).toMatchObject({
      status: "setup_pending",
      fixConnectionId: "con_no_draft",
    })
    expect(statusLabel(state)).toBe("Setup not finished")
  })

  it("counts the connections when more than one is connected", () => {
    const connections = [
      connection("con_gh_1", "github", "connected"),
      connection("con_gh_2", "github", "connected"),
      connection("con_sl", "slack", "connected"),
    ]
    expect(statusLabel(rowOf(connections, "GitHub").state)).toBe("2 connected")
    expect(statusLabel(rowOf(connections, "Slack").state)).toBe("Connected")
    expect(rowOf(connections, "Slack").state).toMatchObject({
      fixConnectionId: null,
    })
  })

  it("gives no label to a provider with no connection, and Coming soon to a planned one", () => {
    expect(statusLabel(rowOf([], "Plain").state)).toBeNull()
    expect(statusLabel(rowOf([], "Zendesk").state)).toBe("Coming soon")
  })

  it("reads a Forge connection as Confluence", () => {
    const connections = [connection("con_cf", "forge", "connected")]
    expect(rowOf(connections, "Confluence").state).toMatchObject({ count: 1 })
  })
})

describe("the views of the catalog", () => {
  const connections = [
    connection("con_gh", "github", "connected"),
    connection("con_li", "linear", "setup_pending"),
  ]

  it("counts the connectors in each view", () => {
    expect(
      catalogViews(catalogRows(connections)).map(
        (view) => `${view.name} ${view.count}`,
      ),
    ).toEqual([
      "All 12",
      "Connected 2",
      "Code and CI 3",
      "Docs and design 4",
      "Work tracking 1",
      "Conversations 1",
      "Support 2",
      "Operations 1",
      "Coming soon 4",
    ])
  })

  it("lists the rows of a view", () => {
    const rows = catalogRows(connections)
    const names = (view: Parameters<typeof rowsInView>[1], query = "") =>
      rowsInView(rows, view, query).map((row) => row.entry.name)
    expect(names("connected")).toEqual(["GitHub", "Linear"])
    expect(names("support")).toEqual(["Plain", "Zendesk"])
    expect(names("coming_soon")).toEqual([
      "Backstage",
      "Google Drive",
      "Figma",
      "Zendesk",
    ])
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
