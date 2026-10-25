import { describe, expect, it } from "vitest"

import type { LinearScope } from "@/features/connectors/queries/linear-connector"

import {
  linearChecklistItems,
  linearScopeFromSelection,
  linearSelection,
  matchLinearSelection,
} from "./linear-scope"

const available: LinearScope[] = [
  { externalId: "t1", type: "team", title: "Engineering", teamKey: "ENG" },
  { externalId: "p1", type: "project", title: "Launch", teamKey: "ENG" },
  { externalId: "d1", type: "document", title: "Notes" },
]

describe("Linear scope editor helpers", () => {
  it("lists teams and projects, and keeps a selected team that Linear does not list", () => {
    const items = linearChecklistItems(available, ["team:OLD", "team:eng"])
    expect(items.map((item) => [item.value, item.code, item.detail])).toEqual([
      ["team:ENG", "ENG", undefined],
      ["project:p1", "ENG", undefined],
      ["team:OLD", "OLD", "Not found in Linear"],
    ])
    expect(matchLinearSelection(items, ["team:eng"])).toEqual(["team:ENG"])
  })

  it("reads a scope into a selection and writes it back", () => {
    const base = { teams: ["ENG"], projects: ["p1"], extra: 1 }
    const selection = linearSelection(base)
    expect(selection).toEqual(["team:ENG", "project:p1"])
    expect(
      linearScopeFromSelection({
        base,
        selection,
        includeCustomerRequests: false,
      }),
    ).toEqual({
      extra: 1,
      teams: ["ENG"],
      projects: ["p1"],
      customerRequests: "exclude",
    })
  })

  it("gives null for an empty selection", () => {
    expect(
      linearScopeFromSelection({
        base: {},
        selection: [],
        includeCustomerRequests: true,
      }),
    ).toBeNull()
    expect(linearSelection({})).toEqual([])
  })
})
