import { describe, expect, it } from "vitest"
import { addedOwnershipField, isHostOnlyPath } from "./host-only.js"

describe("isHostOnlyPath", () => {
  it.each([
    ".ctxpipe/sources.yaml",
    ".ctxpipe/workspace.yaml",
    ".ctxpipe/skills/release/SKILL.md",
    ".ctxpipe",
    ".CTXPIPE/sources.yaml",
    "sources",
    "sources/github/example-org/checkout-api.md",
    "sources/linear/eng.md",
    "Sources/github/evil/exfil.md",
    "SOURCES/notion/wiki.md",
  ])("finds the host-only path %s", (path) => {
    expect(isHostOnlyPath(path)).toBe(true)
  })

  it.each([
    "notes.md",
    "knowledge/services/checkout.md",
    "docs/.ctxpipe/sources.yaml",
    ".ctxpipe-notes.md",
    ".agents/skills/x/SKILL.md",
    "knowledge/sources/notes.md",
    "sources-notes.md",
    "sourcesx/github/a.md",
  ])("lets the agent write %s", (path) => {
    expect(isHostOnlyPath(path)).toBe(false)
  })
})

const human = "---\nkind: Service\nname: Checkout\n---\n\n# Checkout\n"
const generated = (sources: string[]) =>
  `---\nkind: Service\nname: Checkout\ngenerated_by: ctxpipe-extract\nsources:\n${sources.map((s) => `  - ${s}`).join("\n")}\n---\n\n# Checkout\n`

describe("addedOwnershipField", () => {
  it("refuses generated_by that an agent adds to a human file", () => {
    expect(
      addedOwnershipField(
        human,
        human.replace(
          "name: Checkout\n",
          "name: Checkout\ngenerated_by: ctxpipe-extract\n",
        ),
      ),
    ).toBe("generated_by")
  })

  it("refuses a sources list that an agent adds to a human file", () => {
    expect(
      addedOwnershipField(
        human,
        human.replace("name: Checkout\n", "name: Checkout\nsources:\n  - a\n"),
      ),
    ).toBe("sources")
  })

  it("refuses a new file that already claims ingestion ownership", () => {
    expect(addedOwnershipField(null, generated(["a"]))).toBe("generated_by")
  })

  it("refuses a changed generated_by value", () => {
    expect(
      addedOwnershipField(
        generated(["a"]),
        generated(["a"]).replace("ctxpipe-extract", "other"),
      ),
    ).toBe("generated_by")
  })

  it("refuses a source that an agent adds to the list", () => {
    expect(addedOwnershipField(generated(["a"]), generated(["a", "b"]))).toBe(
      "sources",
    )
  })

  it.each([
    ["removes generated_by and sources", generated(["a"]), human],
    ["removes one source", generated(["a", "b"]), generated(["b"])],
    ["keeps the fields", generated(["a"]), `${generated(["a"])}More.\n`],
    ["edits a human file", human, `${human}More.\n`],
    ["creates a human file", null, human],
    ["writes a file without front matter", null, "# Notes\n"],
  ])("accepts a write that %s", (_name, before, after) => {
    expect(addedOwnershipField(before, after)).toBeNull()
  })
})
