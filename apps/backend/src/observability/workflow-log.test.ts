import { initLogger } from "evlog"
import { afterEach, describe, expect, it } from "vitest"
import { withTestLogger } from "../test/with-test-logger.js"
import { flushWorkflowLog, getLogger } from "./logger.js"

describe("flushWorkflowLog", () => {
  afterEach(() => {
    initLogger({
      enabled: false,
      env: { service: "ctxpipe-backend-test" },
    })
  })

  it("rotates so later set/info are not late writes", async () => {
    initLogger({
      enabled: true,
      pretty: false,
      env: { service: "ctxpipe-backend-test" },
    })
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
