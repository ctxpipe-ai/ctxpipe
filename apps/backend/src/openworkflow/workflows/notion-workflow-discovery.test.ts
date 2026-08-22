import { readdir } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"

vi.mock("../client.js", () => ({
  runWorkflowWithWorkerWake: vi.fn(),
  ow: {},
}))

describe("Notion workflow discovery", () => {
  it("keeps Notion workflows in the OpenWorkflow CLI discovery directory", async () => {
    const files = await readdir(dirname(fileURLToPath(import.meta.url)))

    expect(files).toEqual(
      expect.arrayContaining([
        "notion-sync-config.ts",
        "notion-sync-content.ts",
        "notion-sync-entity.ts",
      ]),
    )

    const [{ notionSyncConfig }, { notionSyncContent }, { notionSyncEntity }] =
      await Promise.all([
        import("./notion-sync-config.js"),
        import("./notion-sync-content.js"),
        import("./notion-sync-entity.js"),
      ])

    expect(notionSyncConfig.spec.name).toBe("notion-sync-config")
    expect(notionSyncContent.spec.name).toBe("notion-sync-content")
    expect(notionSyncEntity.spec.name).toBe("notion-sync-entity")
  })
})
