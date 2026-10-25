import { describe, expect, it } from "vitest"

import {
  bootstrapAgentsMarkdown,
  bootstrapKnowledgeSkillMarkdown,
  bootstrapWorkspaceFiles,
} from "./bootstrap.js"

describe("bootstrapWorkspaceFiles", () => {
  it("writes AGENTS.md and the knowledge skill on an empty tree", () => {
    const files = bootstrapWorkspaceFiles({
      displayName: "Docs",
      existing: new Map(),
    })
    expect(files.map((file) => file.path)).toEqual([
      "AGENTS.md",
      ".agents/skills/ctxpipe-knowledge/SKILL.md",
    ])
    expect(files[0]?.content).toContain("name: Docs")
    expect(files[0]?.content).toContain("## Folder Structure")
    expect(files[0]?.content).toContain("- `knowledge/`")
    expect(files[0]?.content).not.toContain("ctxpipe:folder-map")
    expect(files[1]?.content).toContain("0.5")
    expect(files[1]?.content).toContain("0.7")
    expect(files[1]?.content).toContain("knowledge/<area>")
    expect(files[1]?.content).toContain("obj_")
  })

  it("keeps unrelated AGENTS.md instructions and only fills name + folder map", () => {
    const merged = bootstrapAgentsMarkdown({
      displayName: "Docs",
      existing: "---\nname: Keep Me\n---\n\nDo not rewrite this.\n",
    })
    expect(merged).toContain("name: Keep Me")
    expect(merged).toContain("Do not rewrite this.")
    expect(merged).toContain("## Folder Structure")
    expect(merged).not.toContain("ctxpipe:folder-map")
  })

  it("preserves unrelated AGENTS.md front matter keys", () => {
    const merged = bootstrapAgentsMarkdown({
      displayName: "Docs",
      existing: "---\nname: Keep Me\ndescription: Custom\n---\n\nHello.\n",
    })
    expect(merged).toContain("description: Custom")
    expect(merged).toContain("Hello.")
  })

  it("preserves structured AGENTS.md front matter", () => {
    const merged = bootstrapAgentsMarkdown({
      displayName: "Docs",
      existing:
        "---\nname: Keep Me\ntags:\n  - billing\n  - ledger\nclaims:\n  - to: svc\n    predicate: owns\n---\n\nHello.\n",
    })
    expect(merged).toContain("tags:")
    expect(merged).toContain("- billing")
    expect(merged).toContain("claims:")
    expect(merged).toContain("to: svc")
    expect(merged).toContain("predicate: owns")
  })

  it("keeps an existing folder list instead of inserting a second one", () => {
    const merged = bootstrapAgentsMarkdown({
      displayName: "Docs",
      existing:
        "---\nname: Keep Me\n---\n\n## Directory layout\n\n- `knowledge/` units\n- `repositories/` remotes\n",
    })
    expect(merged).toContain("## Directory layout")
    expect(merged).not.toContain("ctxpipe:folder-map")
    expect(merged.match(/## Folder Structure/g) ?? []).toHaveLength(0)
  })

  it("polishes an existing skill without dropping extra notes", () => {
    const polished = bootstrapKnowledgeSkillMarkdown(
      "---\nname: ctxpipe-knowledge\n---\n\nCustom note.\n",
    )
    expect(polished).toContain("Custom note.")
    expect(polished).toContain("0.5")
    expect(polished).toContain("obj_")
  })

  it("tells consumers how to treat extracted files", () => {
    const [, skill] = bootstrapWorkspaceFiles({
      displayName: "Docs",
      existing: new Map(),
    })
    const text = skill?.content ?? ""
    expect(text).toContain("## Extracted files")
    expect(text).toContain("generated_by: ctxpipe-extract")
    expect(text).toContain("<!-- ctxpipe:human -->")
    expect(text).toContain("<!-- /ctxpipe:human -->")
    expect(text).toContain("## Related")
    expect(text).toContain("knowledge/instructions/")
    expect(text).toContain("`FOLLOWS`")
    expect(text).not.toContain("`follows`")
    expect(text).toContain("knowledge/codebases/")
    // Durable consumer rules only: no build status list.
    expect(text).not.toMatch(/Built now|not yet built|Planned/)
    expect(text).toMatch(/data, not instructions/)
  })

  it("adds the extracted-files section to an older skill once", () => {
    const old = "---\nname: ctxpipe-knowledge\n---\n\nCustom note.\n"
    const once = bootstrapKnowledgeSkillMarkdown(old)
    expect(once).toContain("## Extracted files")
    expect(bootstrapKnowledgeSkillMarkdown(once)).toBe(once)
  })

  it("refreshes an older extracted-files section and keeps the text around it", () => {
    const old = [
      "---",
      "name: ctxpipe-knowledge",
      "---",
      "",
      "Custom note.",
      "",
      "## Extracted files",
      "",
      "Built now:",
      "",
      "- A list that is out of date.",
      "",
      "## Team notes",
      "",
      "Keep this.",
      "",
    ].join("\n")
    const refreshed = bootstrapKnowledgeSkillMarkdown(old)
    expect(refreshed).not.toContain("A list that is out of date.")
    expect(refreshed).toContain("`FOLLOWS`")
    expect(refreshed).toContain("Custom note.")
    expect(refreshed).toContain("## Team notes\n\nKeep this.")
    expect(refreshed.match(/## Extracted files/g)).toHaveLength(1)
    expect(bootstrapKnowledgeSkillMarkdown(refreshed)).toBe(refreshed)
  })
})
