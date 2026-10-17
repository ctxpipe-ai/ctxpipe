import { describe, expect, it } from "vitest"
import {
  agentsMdBlocks,
  applyFolderListChoice,
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

  it("lists only the root of a connector mirror", () => {
    expect(
      listedFolders([
        "slack/general/2026-10.md",
        "pagerduty/services/P1/incident.md",
        "notion/page/child.md",
      ]),
    ).toEqual(["notion/", "pagerduty/", "slack/"])
    expect(
      folderSetChanged(["slack/general/a.md"], ["slack/random/a.md"]),
    ).toBe(false)
  })

  it("ignores a change deeper than the list", () => {
    expect(
      folderSetChanged(["knowledge/a/x/1.md"], ["knowledge/a/y/1.md"]),
    ).toBe(false)
  })
})

describe("folder list update", () => {
  const folders = {
    previous: ["gone/", "guides/", "knowledge/"],
    current: ["guides/", "knowledge/", "knowledge/billing/", "runbooks/"],
  }
  const agentsMd = [
    "---",
    "name: Docs",
    "---",
    "",
    "Read this first.",
    "",
    "## Rules",
    "",
    "- Never push to main.",
    "- Keep [knowledge](knowledge/) reviewed.",
    "",
    "### What lives where",
    "",
    "* [knowledge](knowledge/): team knowledge",
    "* [gone](gone/): old notes",
    "",
    "```md",
    "- [guides](guides/)",
    "",
    "- [runbooks](runbooks/)",
    "```",
    "",
    "<!-- a comment",
    "- [guides](guides/)",
    "-->",
    "",
    "Keep this paragraph.",
    "",
  ].join("\n")
  const blocks = agentsMdBlocks(agentsMd)
  const index = (text: string) =>
    blocks.findIndex((block) => block.text.includes(text))
  const appended =
    "\n## Folders\n\n- `guides/`\n- `knowledge/`\n- `runbooks/`\n"

  it("numbers body blocks without front matter, fences, or comments", () => {
    expect(blocks.map((block) => block.text)).toEqual([
      "Read this first.",
      "## Rules",
      "- Never push to main.\n- Keep [knowledge](knowledge/) reviewed.",
      "### What lives where",
      "* [knowledge](knowledge/): team knowledge\n* [gone](gone/): old notes",
      "Keep this paragraph.",
    ])
  })

  it("updates the list under an unusual heading and keeps other bytes", () => {
    expect(applyFolderListChoice(agentsMd, folders, index("[gone]"))).toBe(
      agentsMd.replace(
        "* [gone](gone/): old notes\n",
        "- `guides/`\n- `runbooks/`\n",
      ),
    )
  })

  it("does not take a rules list that names one folder", () => {
    expect(applyFolderListChoice(agentsMd, folders, index("Never push"))).toBe(
      agentsMd + appended,
    )
  })

  it.each([
    [
      "a rule as a continuation",
      "* [knowledge](knowledge/)\n  Never push to main.",
    ],
    ["an outside link", "- `knowledge/` [click](https://example.com/x)"],
    ["an image", "- [knowledge](knowledge/) ![x](knowledge/)"],
    ["a reference link", "- [knowledge](knowledge/) [more][1]"],
    ["two folders", "- [knowledge](knowledge/) and `guides/`"],
    ["a file link", "- [knowledge](knowledge/a.md)"],
  ])("does not take a list with %s", (_name, list) => {
    const text = `# Notes\n\n${list}\n`
    expect(applyFolderListChoice(text, folders, 1)).toBe(`${text}${appended}`)
  })

  it("never targets a list inside a fence", () => {
    const text = "# Notes\n\n```\n- [gone](gone/)\n```\n"
    expect(agentsMdBlocks(text)).toHaveLength(1)
    expect(applyFolderListChoice(text, folders, 1)).toBe(`${text}${appended}`)
  })

  it("appends a Folders section for none", () => {
    const plain = "---\nname: Docs\n---\n\nRead this first.\n"
    expect(applyFolderListChoice(plain, folders, "none")).toBe(plain + appended)
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
