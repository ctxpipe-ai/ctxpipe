import { describe, expect, it } from "vitest"
import { withTestLogger } from "../test/with-test-logger.js"
import { flushWorkflowLog, getLogger } from "./logger.js"

describe("flushWorkflowLog", () => {
  it("rotates so later set/info are not late writes", async () => {
    await withTestLogger(async () => {
      getLogger().set({ step: "first" })
      getLogger().info("first")
      flushWorkflowLog()
      getLogger().set({
        step: "codeIngestion.deduplicateAndStore.progress",
      })
      getLogger().info("second")
      expect(getLogger().getContext().step).toBe(
        "codeIngestion.deduplicateAndStore.progress",
      )
    })
  })
})
