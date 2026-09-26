import { readdir } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"

vi.mock("../client.js", () => ({
  runWorkflowWithWorkerWake: vi.fn(),
}))

describe("PagerDuty workflow discovery", () => {
  it("keeps PagerDuty workflows in the OpenWorkflow CLI discovery directory", async () => {
    const files = await readdir(dirname(fileURLToPath(import.meta.url)))

    expect(files).toEqual(
      expect.arrayContaining([
        "pagerduty-sync-config.ts",
        "pagerduty-sync-content.ts",
        "pagerduty-sync-entity.ts",
      ]),
    )

    const [
      { pagerdutySyncConfig },
      { pagerdutySyncContent },
      { pagerdutySyncEntity },
    ] = await Promise.all([
      import("./pagerduty-sync-config.js"),
      import("./pagerduty-sync-content.js"),
      import("./pagerduty-sync-entity.js"),
    ])

    expect(pagerdutySyncConfig.spec.name).toBe("pagerduty-sync-config")
    expect(pagerdutySyncContent.spec.name).toBe("pagerduty-sync-content")
    expect(pagerdutySyncEntity.spec.name).toBe("pagerduty-sync-entity")
  }, 20_000)
})
