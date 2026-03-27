import { describe, expect, it } from "vitest"
import { langfusePipelineCallbacks } from "./langfusePipelineMetrics.js"
import { runWithLangfuseContext, tryGetLangfuseHandler } from "./langfuse.js"

describe("langfusePipelineCallbacks", () => {
  it("does not throw when Langfuse AsyncLocalStorage context is absent", () => {
    expect(tryGetLangfuseHandler()).toBeUndefined()
    const cbs = langfusePipelineCallbacks({ step: "test.step" })
    expect(cbs).toHaveLength(1)
    expect(cbs[0].name).toBe("langfuse-pipeline-metrics")
  })

  it("includes Langfuse handler first when runWithLangfuseContext is active", async () => {
    await runWithLangfuseContext({}, async () => {
      expect(tryGetLangfuseHandler()).toBeDefined()
      const cbs = langfusePipelineCallbacks({ step: "test.step" })
      expect(cbs).toHaveLength(2)
      expect(cbs[1].name).toBe("langfuse-pipeline-metrics")
    })
  })
})
