import { readdir } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

describe("Slack workflow discovery", () => {
  it("keeps Slack workflows in the OpenWorkflow CLI discovery directory", async () => {
    const files = await readdir(dirname(fileURLToPath(import.meta.url)))

    expect(files).toEqual(expect.arrayContaining(["slack-capture-thread.ts"]))

    const { slackCaptureThread } = await import("./slack-capture-thread.js")

    expect(slackCaptureThread.spec.name).toBe("slack-capture-thread")
  })
})
