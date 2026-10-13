import { readdir } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"

vi.mock("../client.js", () => ({
  runWorkflowWithWorkerWake: vi.fn(),
}))

describe("GitHub workflow discovery", () => {
  it("keeps the GitHub issue workflow in the OpenWorkflow CLI discovery directory", async () => {
    const files = await readdir(dirname(fileURLToPath(import.meta.url)))
    expect(files).toContain("github-sync-issue.ts")

    const { githubSyncIssue } = await import("./github-sync-issue.js")
    expect(githubSyncIssue.spec.name).toBe("github-sync-issue")
  }, 20_000)
})
