import { readdir } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

describe("Slack workflow discovery", () => {
  it("keeps Slack workflows in the OpenWorkflow CLI discovery directory", async () => {
    const files = await readdir(dirname(fileURLToPath(import.meta.url)))

    expect(files).toEqual(
      expect.arrayContaining([
        "slack-sync-config.ts",
        "slack-sync-content.ts",
        "slack-sync-flush.ts",
      ]),
    )

    const [
      { slackSyncConfig },
      { slackSyncContent },
      { slackSyncFlush },
    ] = await Promise.all([
      import("./slack-sync-config.js"),
      import("./slack-sync-content.js"),
      import("./slack-sync-flush.js"),
    ])

    expect(slackSyncConfig.spec.name).toBe("slack-sync-config")
    expect(slackSyncContent.spec.name).toBe("slack-sync-content")
    expect(slackSyncFlush.spec.name).toBe("slack-sync-flush")
  })
})
