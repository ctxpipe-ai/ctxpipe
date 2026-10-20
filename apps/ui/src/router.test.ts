import { describe, expect, it } from "vitest"
import { retryQuery } from "./lib/api-result"
import { getRouter } from "./router"

describe("getRouter", () => {
  it("uses retryQuery as the QueryClient default", () => {
    const router = getRouter()
    expect(
      router.options.context.queryClient.getDefaultOptions().queries?.retry,
    ).toBe(retryQuery)
  })
})
