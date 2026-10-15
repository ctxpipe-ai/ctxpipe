import { describe, expect, it } from "vitest"
import { bootstrapWorkspaceFiles } from "./bootstrap.js"
import { planHydrateWrites } from "./hydrate-write-planner.js"
import type { WorkspaceRevision } from "./revision.js"

const revision: WorkspaceRevision = {
  workspaceId: "ws_planner",
  generation: 1,
  remote: {
    url: "https://github.com/acme/knowledge",
    connectionId: "con_gh",
  },
  defaultBranch: "main",
  sha: "a".repeat(40),
  access: "read",
}

const declaration = (git: string, branch?: string) =>
  `---\ngit: ${git}\n${branch ? `branch: ${branch}\n` : ""}---\n`

function plan(files: Array<{ path: string; content: string }>) {
  const bootstrapped = bootstrapWorkspaceFiles({
    displayName: "Knowledge",
    existing: new Map(),
  })
  return planHydrateWrites({
    revision,
    displayName: "Knowledge",
    files: [...bootstrapped, ...files],
  })
}

describe("planHydrateWrites: repository files of ADR-050", () => {
  it("plans no write for repository files (the conversion moves them)", () => {
    expect(
      plan([
        {
          path: "repositories/web.md",
          content: declaration("https://github.com/Acme/Web.git", "stable"),
        },
        {
          path: "repositories/api.md",
          content: declaration("https://github.com/acme/api"),
        },
      ]),
    ).toEqual([])
  })
})
