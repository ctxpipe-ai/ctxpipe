import { describe, expect, it } from "vitest"
import { applySourceFileChange, SourceFileEditError } from "./edit.js"

const base = `# Sources of this Workspace
version: 1
sources:
  # Product issues
  - id: eng-issues
    provider: linear
    connection: con_linear1
    teams: [ENG]
`

describe("applySourceFileChange", () => {
  it("creates the file and picks a free key from the provider", () => {
    const first = applySourceFileChange(null, {
      action: "add",
      provider: "slack",
      connectionId: "con_slack1",
      scope: { channels: ["C1"] },
    })
    expect(first.sourceKey).toBe("slack")
    const second = applySourceFileChange(first.text, {
      action: "add",
      provider: "slack",
      connectionId: "con_slack1",
      scope: {},
    })
    expect(second.sourceKey).toBe("slack-2")
    expect(second.text).toContain("id: slack-2")
  })

  it("edits one entry and keeps comments and the other entries", () => {
    const added = applySourceFileChange(base, {
      action: "add",
      sourceKey: "eng-docs",
      provider: "confluence",
      connectionId: "con_forge1",
      scope: { spaces: [{ key: "ENG", pages: "all" }] },
    })
    const edited = applySourceFileChange(added.text, {
      action: "edit",
      sourceKey: "eng-issues",
      provider: "linear",
      connectionId: "con_linear1",
      scope: { teams: ["ENG", "OPS"] },
    })
    expect(edited.text).toContain("# Sources of this Workspace")
    expect(edited.text).toContain("id: eng-docs")
    expect(edited.text.indexOf("eng-issues")).toBeLessThan(
      edited.text.indexOf("eng-docs"),
    )
    expect(edited.entry?.scope).toEqual({ teams: ["ENG", "OPS"] })
  })

  it("removes an entry", () => {
    const removed = applySourceFileChange(base, {
      action: "remove",
      sourceKey: "eng-issues",
    })
    expect(removed.text).not.toContain("eng-issues")
    expect(removed.text).toContain("version: 1")
  })

  it("refuses an unknown key, a taken key, a bad entry, and a broken file", () => {
    const reason = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        if (error instanceof SourceFileEditError) return error.reason
      }
      return null
    }
    expect(
      reason(() =>
        applySourceFileChange(base, { action: "remove", sourceKey: "nope" }),
      ),
    ).toBe("not_found")
    expect(
      reason(() =>
        applySourceFileChange(base, {
          action: "add",
          sourceKey: "eng-issues",
          provider: "linear",
          connectionId: "con_linear1",
          scope: {},
        }),
      ),
    ).toBe("conflict")
    expect(
      reason(() =>
        applySourceFileChange(base, {
          action: "add",
          sourceKey: "Bad Key",
          provider: "linear",
          connectionId: "con_linear1",
          scope: {},
        }),
      ),
    ).toBe("invalid")
    expect(
      reason(() =>
        applySourceFileChange("version: 9\n", {
          action: "remove",
          sourceKey: "x",
        }),
      ),
    ).toBe("conflict")
  })
})
