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
    expect(merged).toContain("<!-- ctxpipe:folder-map -->")
  })

  it("preserves unrelated AGENTS.md front matter keys", () => {
    const merged = bootstrapAgentsMarkdown({
      displayName: "Docs",
      existing: "---\nname: Keep Me\ndescription: Custom\n---\n\nHello.\n",
    })
    expect(merged).toContain("description: Custom")
    expect(merged).toContain("Hello.")
  })

  it("polishes an existing skill without dropping extra notes", () => {
    const polished = bootstrapKnowledgeSkillMarkdown(
      "---\nname: ctxpipe-knowledge\n---\n\nCustom note.\n",
    )
    expect(polished).toContain("Custom note.")
    expect(polished).toContain("0.5")
    expect(polished).toContain("obj_")
  })
})
