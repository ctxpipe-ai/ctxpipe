import { describe, expect, it } from "vitest"
import {
  WORKSPACE_CHAT_ORIENTATION_MAX_CHARS,
  workspaceChatOrientationPrompt,
} from "./workspace-chat-orientation.js"

describe("workspaceChatOrientationPrompt", () => {
  it("stays under the cap with many long repository and folder names", () => {
    const text = workspaceChatOrientationPrompt({
      repositories: Array.from({ length: 60 }, (_, i) => ({
        id: `repo_${String(i).padStart(24, "0")}`,
        name: `example-org/${"very-long-repository-name-".repeat(6)}${i}`,
      })),
      folders: Array.from({ length: 20 }, (_, i) => ({
        folder: `${"deeply-named-knowledge-folder-".repeat(4)}${i}`,
        files: 500 - i,
      })),
      totalFolders: 900,
      totalFiles: 40_000,
      rootPath: "docs/context",
    })
    expect(text.length).toBeLessThanOrEqual(
      WORKSPACE_CHAT_ORIENTATION_MAX_CHARS,
    )
    const parsed = JSON.parse(text)
    expect(parsed.type).toBe("workspace_orientation")
    expect(parsed.knowledge).toMatchObject({
      files: 40_000,
      folders: 900,
      readForMore: "docs/context/AGENTS.md",
    })
    // Folders go first, so at least one repository id stays.
    expect(parsed.repositories.length).toBeGreaterThan(0)
  })

  it("gives the same text for the same Workspace in any input order", () => {
    const repositories = [
      { id: "repo_b", name: "beta" },
      { id: "repo_a", name: "alpha" },
      { id: "repo_a", name: "alpha" },
    ]
    const folders = [
      { folder: "", files: 2 },
      { folder: "decisions", files: 9 },
      { folder: "runbooks", files: 9 },
    ]
    const input = { repositories, folders, totalFolders: 3, totalFiles: 20 }
    const text = workspaceChatOrientationPrompt(input)
    expect(
      workspaceChatOrientationPrompt({
        ...input,
        repositories: [...repositories].reverse(),
        folders: [...folders].reverse(),
      }),
    ).toBe(text)
    expect(JSON.parse(text)).toMatchObject({
      repositories: [
        { id: "repo_a", name: "alpha" },
        { id: "repo_b", name: "beta" },
      ],
      knowledge: {
        largestFolders: [
          { path: "decisions/", files: 9 },
          { path: "runbooks/", files: 9 },
          { path: ".", files: 2 },
        ],
        readForMore: "AGENTS.md",
      },
    })
  })
})
