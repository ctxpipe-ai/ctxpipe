import { describe, expect, it } from "vitest"
import {
  folderListEditIsSafe,
  folderSetChanged,
  listedFolders,
  removeFolderMapMarkers,
} from "./folder-list.js"

describe("folder set", () => {
  it("lists folders to depth two and skips hidden folders", () => {
    expect(
      listedFolders([
        "AGENTS.md",
        "knowledge/billing/invoices/2026.md",
        "knowledge/billing/overview.md",
        "repositories/api.md",
        ".agents/skills/x/SKILL.md",
      ]),
    ).toEqual(["knowledge/", "knowledge/billing/", "repositories/"])
  })

  it("ignores file changes inside the same folders", () => {
    expect(
      folderSetChanged(
        ["knowledge/a.md", "repositories/api.md"],
        ["knowledge/b.md", "knowledge/c.md", "repositories/web.md"],
      ),
    ).toBe(false)
  })

  it("sees an added, removed, or moved folder", () => {
    expect(folderSetChanged(["knowledge/a.md"], ["knowledge/x/a.md"])).toBe(
      true,
    )
    expect(
      folderSetChanged(["knowledge/a.md", "notes/b.md"], ["knowledge/a.md"]),
    ).toBe(true)
  })

  it("ignores a change deeper than the list", () => {
    expect(
      folderSetChanged(["knowledge/a/x/1.md"], ["knowledge/a/y/1.md"]),
    ).toBe(false)
  })
})

describe("folder list edit check", () => {
  const before = [
    "---",
    "name: Docs",
    "---",
    "",
    "Read this first.",
    "",
    "## Where things live",
    "",
    "- `knowledge/` — team knowledge",
    "",
    "## Rules",
    "",
    "Be kind.",
    "",
  ].join("\n")

  it("accepts an edit inside the list", () => {
    expect(
      folderListEditIsSafe(
        before,
        before.replace(
          "- `knowledge/` — team knowledge\n",
          "- `knowledge/` — team knowledge\n- `runbooks/` — on-call steps\n",
        ),
      ),
    ).toBe(true)
  })

  it("rejects an edit outside the list", () => {
    expect(
      folderListEditIsSafe(
        before,
        before
          .replace("Be kind.", "Be nice.")
          .replace(
            "- `knowledge/` — team knowledge\n",
            "- `knowledge/` — team knowledge\n- `runbooks/`\n",
          ),
      ),
    ).toBe(false)
    expect(
      folderListEditIsSafe(before, before.replace("name: Docs", "name: X")),
    ).toBe(false)
  })

  it("accepts one new section with a heading and a list", () => {
    const plain = "---\nname: Docs\n---\n\nRead this first.\n"
    expect(
      folderListEditIsSafe(
        plain,
        `${plain}\n## Folders\n\n- \`knowledge/\` — team knowledge\n`,
      ),
    ).toBe(true)
    expect(
      folderListEditIsSafe(
        plain,
        `${plain}\n## Folders\n\nSome prose.\n\n- \`knowledge/\`\n`,
      ),
    ).toBe(false)
  })
})

describe("marker cleanup", () => {
  it("removes only the marker lines and keeps the list", () => {
    expect(
      removeFolderMapMarkers(
        "# Notes\n\n<!-- ctxpipe:folder-map -->\n## Folders\n- `a/`\n  <!-- /ctxpipe:folder-map -->\n\nEnd\n",
      ),
    ).toBe("# Notes\n\n## Folders\n- `a/`\n\nEnd\n")
  })

  it("keeps a file with no markers byte for byte", () => {
    const text = "# Notes\r\n\r\n- `a/`\r\n"
    expect(removeFolderMapMarkers(text)).toBe(text)
  })
})
