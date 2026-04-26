import { describe, expect, it } from "vitest"
import { mapForgeCliOutputToErrorCode } from "./forge-provision-error-map.js"

describe("mapForgeCliOutputToErrorCode", () => {
  it("maps 401 to forge_auth_failed", () => {
    expect(
      mapForgeCliOutputToErrorCode(
        1,
        "Request failed 401 invalid token for forge",
      ),
    ).toBe("forge_auth_failed")
  })

  it("maps network errors", () => {
    expect(
      mapForgeCliOutputToErrorCode(1, "getaddrinfo ENOTFOUND auth.atlassian.com"),
    ).toBe("network")
  })

  it("returns unknown for opaque failures", () => {
    expect(mapForgeCliOutputToErrorCode(1, "something odd")).toBe("unknown")
  })
})
