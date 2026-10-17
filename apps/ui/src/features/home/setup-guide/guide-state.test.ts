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
  it("gives an admin six rows", () => {
    const rows = guideRows(noSignals)
    expect(ids(rows)).toEqual([
      "github",
      "workspace",
      "repositories",
      "ask",
      "tool",
      "invite",
    ])
    expect(doneIds(rows)).toEqual([])
  })

  it("marks each admin row from its own signal", () => {
    const rows = guideRows({
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
    expect(doneIds(all)).toHaveLength(6)
    expect(all.find((row) => row.id === "workspace")?.building).toBe(false)
  })

  it("never gives a member the GitHub, tool or invite rows", () => {
    const member = { ...noSignals, role: "member" as const }
    expect(ids(guideRows(member))).toEqual(["workspace", "ask", "explore"])
    const withWorkspace = guideRows({
      ...member,
      workspaceCount: 1,
      explored: true,
    })
    expect(ids(withWorkspace)).toEqual(["ask", "explore"])
    expect(doneIds(withWorkspace)).toEqual(["explore"])
  })
})

describe("guideView", () => {
  const now = Date.parse("2026-10-12T12:00:00.000Z")
  const appBootAt = now - 60_000
  const newUser = "2026-10-10T12:00:00.000Z"
  const base = {
    prefs: {},
    onboardingCompletedAt: newUser,
    orgCreatedAt: "2026-01-01T00:00:00.000Z",
    workspaceCount: 0,
    now,
    appBootAt,
  }

  it("is open and expanded with the first open row as next", () => {
    const view = guideView({ ...base, rows: guideRows(noSignals) })
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
    })
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
    })
    expect(
      guideView({ ...base, rows: asked, prefs: { collapsed: false } }),
    ).toMatchObject({ kind: "open", collapsed: false })
    expect(
      guideView({
        ...base,
        rows: guideRows(noSignals),
        prefs: { collapsed: true },
      }),
    ).toMatchObject({ kind: "open", collapsed: true })
  })

  it("is hidden after a dismiss", () => {
    const view = guideView({
      ...base,
      rows: guideRows(noSignals),
      prefs: { dismissedAt: "2026-10-11T00:00:00.000Z" },
    })
    expect(view).toEqual({ kind: "hidden" })
  })

  it("is hidden in an older organization with a Workspace when onboarding finished more than 14 days ago, or is unknown", () => {
    const rows = guideRows({ ...noSignals, workspaceCount: 1 })
    const established = { ...base, rows, workspaceCount: 1 }
    expect(
      guideView({
        ...established,
        onboardingCompletedAt: new Date("2026-10-10T12:00:00.000Z"),
      }),
    ).toMatchObject({ kind: "open" })
    expect(
      guideView({
        ...established,
        onboardingCompletedAt: "2026-09-27T11:59:00.000Z",
      }),
    ).toEqual({ kind: "hidden" })
    expect(
      guideView({
        ...established,
        onboardingCompletedAt: "2026-09-28T12:01:00.000Z",
      }),
    ).toMatchObject({ kind: "open" })
    expect(guideView({ ...established, onboardingCompletedAt: null })).toEqual({
      kind: "hidden",
    })
    expect(
      guideView({ ...established, onboardingCompletedAt: undefined }),
    ).toEqual({ kind: "hidden" })
  })

  it("is open for any user in an organization created in the last 14 days", () => {
    const rows = guideRows({ ...noSignals, workspaceCount: 1 })
    const oldUser = { ...base, rows, workspaceCount: 1 }
    expect(
      guideView({
        ...oldUser,
        onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
        orgCreatedAt: "2026-09-28T12:01:00.000Z",
      }),
    ).toMatchObject({ kind: "open" })
    expect(
      guideView({
        ...oldUser,
        onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
        orgCreatedAt: "2026-09-27T11:59:00.000Z",
      }),
    ).toEqual({ kind: "hidden" })
  })

  it("stays open for 14 days after it first showed, also after the first Workspace", () => {
    const rows = guideRows({ ...noSignals, workspaceCount: 1 })
    const old = {
      ...base,
      rows,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      orgCreatedAt: "2026-01-01T00:00:00.000Z",
      workspaceCount: 1,
    }
    expect(
      guideView({ ...old, prefs: { startedAt: "2026-09-28T12:01:00.000Z" } }),
    ).toMatchObject({ kind: "open" })
    expect(
      guideView({ ...old, prefs: { startedAt: "2026-09-27T11:59:00.000Z" } }),
    ).toEqual({ kind: "hidden" })
  })

  it("is open in an organization with no Workspace, at any age, until a dismiss", () => {
    const old = {
      ...base,
      rows: guideRows(noSignals),
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      orgCreatedAt: "2026-01-01T00:00:00.000Z",
      workspaceCount: 0,
    }
    expect(guideView(old)).toMatchObject({ kind: "open", next: "github" })
    expect(
      guideView({ ...old, prefs: { dismissedAt: "2026-10-11T00:00:00.000Z" } }),
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
    })
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
})
