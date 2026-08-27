import { readdir } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"

vi.mock("../client.js", () => ({
  runWorkflowWithWorkerWake: vi.fn(),
}))

describe("Slack workflow discovery", () => {
  it("keeps Slack workflows in the OpenWorkflow CLI discovery directory", async () => {
    const files = await readdir(dirname(fileURLToPath(import.meta.url)))

    expect(files).toEqual(expect.arrayContaining(["slack-mention-agent.ts"]))

    const { slackMentionAgent } = await import("./slack-mention-agent.js")

    expect(slackMentionAgent.spec.name).toBe("slack-mention-agent")
  })
})
