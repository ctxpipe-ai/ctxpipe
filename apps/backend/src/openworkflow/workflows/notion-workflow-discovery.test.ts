import { readdir } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

describe("Notion workflow discovery", () => {
  it("keeps Notion workflows in the OpenWorkflow CLI discovery directory", async () => {
    const files = await readdir(dirname(fileURLToPath(import.meta.url)))

    expect(files).toEqual(
      expect.arrayContaining([
        "notion-sync-config.ts",
        "notion-sync-content.ts",
      ]),
    )

    const [{ notionSyncConfig }, { notionSyncContent }] = await Promise.all([
      import("./notion-sync-config.js"),
      import("./notion-sync-content.js"),
    ])

    expect(notionSyncConfig.spec.name).toBe("notion-sync-config")
    expect(notionSyncContent.spec.name).toBe("notion-sync-content")
  })
})
