import { describe, expect, it } from "vitest"
import { SourceChangeError } from "./edit.js"
import { applySourcesYamlChange } from "./sources-yaml-edit.js"

const base = `# Sources of this Workspace
version: 1
sources:
  # Product issues
  - id: eng-issues
    provider: linear
    connection: con_linear1
    teams: [ENG]
`

describe("applySourcesYamlChange", () => {
  it("creates the file and picks a free key from the provider", () => {
    const first = applySourcesYamlChange(null, {
      action: "add",
      provider: "slack",
      connectionId: "con_slack1",
      scope: { channels: ["C0123ABCD"] },
    })
    expect(first.sourceKey).toBe("slack")
    const second = applySourcesYamlChange(first.text, {
      action: "add",
      provider: "slack",
      connectionId: "con_slack1",
      scope: { channels: ["C0456EFGH"] },
    })
    expect(second.sourceKey).toBe("slack-2")
    expect(second.text).toContain("id: slack-2")
  })

  it("refuses an id that an open pull request changes", () => {
    const add = {
      action: "add" as const,
      provider: "linear" as const,
      connectionId: "con_linear2",
      scope: { teams: ["CTX"] },
    }
    const reserved = new Set(["linear"])
    // A picked id skips it; an id from the caller gets a 409.
    expect(applySourcesYamlChange(base, add, reserved).sourceKey).toBe(
      "linear-2",
    )
    expect(() =>
      applySourcesYamlChange(base, { ...add, sourceKey: "linear" }, reserved),
    ).toThrow(
      expect.objectContaining({
        status: 409,
        message:
          'An open pull request changes the source "linear". Merge or close it first.',
      }),
    )
  })

  it("edits one entry and keeps comments and the other entries", () => {
    const added = applySourcesYamlChange(base, {
      action: "add",
      sourceKey: "eng-docs",
      provider: "confluence",
      connectionId: "con_forge1",
      scope: { spaces: [{ key: "ENG", pages: "all" }] },
    })
    const edited = applySourcesYamlChange(added.text, {
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
    const removed = applySourcesYamlChange(base, {
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
        if (error instanceof SourceChangeError) return error.status
      }
      return null
    }
    expect(
      reason(() =>
        applySourcesYamlChange(base, { action: "remove", sourceKey: "nope" }),
      ),
    ).toBe(404)
    expect(
      reason(() =>
        applySourcesYamlChange(base, {
          action: "add",
          sourceKey: "eng-issues",
          provider: "linear",
          connectionId: "con_linear1",
          scope: {},
        }),
      ),
    ).toBe(409)
    expect(
      reason(() =>
        applySourcesYamlChange(base, {
          action: "add",
          sourceKey: "Bad Key",
          provider: "linear",
          connectionId: "con_linear1",
          scope: {},
        }),
      ),
    ).toBe(400)
    expect(
      reason(() =>
        applySourcesYamlChange("version: 9\n", {
          action: "remove",
          sourceKey: "x",
        }),
      ),
    ).toBe(409)
  })

  it("refuses reserved keys in the scope and oversized or alias-heavy files", () => {
    const reason = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        if (error instanceof SourceChangeError) return error.status
      }
      return null
    }
    const add = {
      action: "add" as const,
      provider: "linear" as const,
      connectionId: "con_linear1",
      scope: { id: "other" },
    }
    expect(reason(() => applySourcesYamlChange(base, add))).toBe(400)
    expect(
      reason(() =>
        applySourcesYamlChange(`${base}# ${"x".repeat(300_000)}\n`, {
          ...add,
          scope: {},
        }),
      ),
    ).toBe(409)
    const aliases = `version: 1\nsources: []\nbomb: &a [x]\nmore: [${Array.from({ length: 200 }, () => "*a").join(", ")}]\n`
    expect(
      reason(() => applySourcesYamlChange(aliases, { ...add, scope: {} })),
    ).toBe(409)
  })
})
