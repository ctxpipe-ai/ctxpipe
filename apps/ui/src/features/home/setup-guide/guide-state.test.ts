import { describe, expect, it } from "vitest"
import {
  type GuideRow,
  type GuideSignals,
  guideRows,
  guideView,
} from "./guide-state"

const noSignals: GuideSignals = {
  role: "admin",
  githubLinked: false,
  workspaceCount: 0,
  landingBuilding: false,
  linkedRepositories: false,
  asked: false,
  toolConnected: false,
  teamInvited: false,
  explored: false,
}

const ids = (rows: GuideRow[]) => rows.map((row) => row.id)
const doneIds = (rows: GuideRow[]) =>
  rows.filter((row) => row.done).map((row) => row.id)

describe("guideRows", () => {
  it("gives an admin six counted rows and the editor row under More", () => {
    const { rows, more } = guideRows(noSignals)
    expect(ids(rows)).toEqual([
      "github",
      "workspace",
      "repositories",
      "ask",
      "tool",
      "invite",
    ])
    expect(doneIds(rows)).toEqual([])
    expect(more).toEqual([{ id: "editor", done: false }])
  })

  it("marks each admin row from its own signal", () => {
    const { rows } = guideRows({
      ...noSignals,
      githubLinked: true,
      workspaceCount: 1,
      landingBuilding: true,
      teamInvited: true,
    })
    expect(doneIds(rows)).toEqual(["github", "workspace", "invite"])
    expect(rows.find((row) => row.id === "workspace")?.building).toBe(true)
    const all = guideRows({
      ...noSignals,
      githubLinked: true,
      workspaceCount: 2,
      linkedRepositories: true,
      asked: true,
      toolConnected: true,
      teamInvited: true,
    })
    expect(doneIds(all.rows)).toHaveLength(6)
    expect(all.rows.find((row) => row.id === "workspace")?.building).toBe(false)
  })

  it("never gives a member the GitHub, tool or invite rows", () => {
    const member = { ...noSignals, role: "member" as const }
    expect(ids(guideRows(member).rows)).toEqual(["workspace", "ask", "explore"])
    const withWorkspace = guideRows({
      ...member,
      workspaceCount: 1,
      explored: true,
    })
    expect(ids(withWorkspace.rows)).toEqual(["ask", "explore"])
    expect(doneIds(withWorkspace.rows)).toEqual(["explore"])
    expect(ids(withWorkspace.more)).toEqual(["editor"])
  })
})

describe("guideView", () => {
  const now = Date.parse("2026-10-12T12:00:00.000Z")
  const appBootAt = now - 60_000
  const newUser = "2026-10-10T12:00:00.000Z"
  const base = {
    prefs: {},
    onboardingCompletedAt: newUser,
    now,
    appBootAt,
  }

  it("is open and expanded with the first open row as next", () => {
    const view = guideView({ ...base, rows: guideRows(noSignals).rows })
    expect(view).toEqual({
      kind: "open",
      collapsed: false,
      done: 0,
      total: 6,
      next: "github",
    })
  })

  it("collapses by default after the first question", () => {
    const rows = guideRows({
      ...noSignals,
      workspaceCount: 1,
      asked: true,
    }).rows
    expect(guideView({ ...base, rows })).toMatchObject({
      kind: "open",
      collapsed: true,
      done: 2,
      next: "github",
    })
  })

  it("keeps the user's own toggle", () => {
    const asked = guideRows({
      ...noSignals,
      workspaceCount: 1,
      asked: true,
    }).rows
    expect(
      guideView({ ...base, rows: asked, prefs: { collapsed: false } }),
    ).toMatchObject({ kind: "open", collapsed: false })
    expect(
      guideView({
        ...base,
        rows: guideRows(noSignals).rows,
        prefs: { collapsed: true },
      }),
    ).toMatchObject({ kind: "open", collapsed: true })
  })

  it("is hidden after a dismiss", () => {
    const view = guideView({
      ...base,
      rows: guideRows(noSignals).rows,
      prefs: { dismissedAt: "2026-10-11T00:00:00.000Z" },
    })
    expect(view).toEqual({ kind: "hidden" })
  })

  it("is hidden when onboarding finished more than 14 days ago, or is unknown", () => {
    const rows = guideRows(noSignals).rows
    expect(
      guideView({
        ...base,
        rows,
        onboardingCompletedAt: "2026-09-27T11:59:00.000Z",
      }),
    ).toEqual({ kind: "hidden" })
    expect(
      guideView({
        ...base,
        rows,
        onboardingCompletedAt: "2026-09-28T12:01:00.000Z",
      }),
    ).toMatchObject({ kind: "open" })
    expect(guideView({ ...base, rows, onboardingCompletedAt: null })).toEqual({
      kind: "hidden",
    })
    expect(
      guideView({ ...base, rows, onboardingCompletedAt: undefined }),
    ).toEqual({ kind: "hidden" })
  })

  it("shows the complete line on the load where all rows become done", () => {
    const rows = guideRows({
      ...noSignals,
      githubLinked: true,
      workspaceCount: 1,
      linkedRepositories: true,
      asked: true,
      toolConnected: true,
      teamInvited: true,
    }).rows
    expect(guideView({ ...base, rows })).toEqual({
      kind: "complete",
      record: true,
    })
    // Recorded on this load: still shown until the next app load.
    expect(
      guideView({
        ...base,
        rows,
        prefs: { completedAt: new Date(now - 1000).toISOString() },
      }),
    ).toEqual({ kind: "complete", record: false })
    // Recorded on an earlier load: removed.
    expect(
      guideView({
        ...base,
        rows,
        prefs: { completedAt: new Date(appBootAt - 1000).toISOString() },
      }),
    ).toEqual({ kind: "hidden" })
  })

  it("does not count the editor row toward completion", () => {
    const member = guideRows({
      ...noSignals,
      role: "member",
      workspaceCount: 1,
      asked: true,
      explored: true,
    })
    expect(member.more[0]?.done).toBe(false)
    expect(guideView({ ...base, rows: member.rows })).toMatchObject({
      kind: "complete",
    })
  })
})
