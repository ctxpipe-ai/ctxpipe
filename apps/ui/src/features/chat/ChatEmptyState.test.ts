import { describe, expect, it } from "vitest"
import { getChatAvailability } from "./ChatEmptyState"

describe("getChatAvailability", () => {
  it("waits for repository state before enabling chat", () => {
    expect(getChatAvailability(undefined, true)).toBe("loading")
  })

  it("directs organisations without repositories to connect one", () => {
    expect(getChatAvailability([], false)).toBe("no-repositories")
  })

  it("enables chat as soon as one repository is ready", () => {
    expect(
      getChatAvailability(
        [
          { indexingStatus: "running" },
          { indexingStatus: "ready", indexReady: true },
        ],
        false,
      ),
    ).toBe("ready")
  })

  it("blocks chat while every available repository is indexing", () => {
    expect(
      getChatAvailability(
        [{ indexingStatus: "queued" }, { indexingStatus: "running" }],
        false,
      ),
    ).toBe("indexing")
  })

  it("enables chat when a repository completed with issues", () => {
    expect(
      getChatAvailability(
        [
          {
            indexingStatus: "complete_with_issues",
            indexReady: true,
          },
        ],
        false,
      ),
    ).toBe("ready")
  })

  it("directs users to repository status when no index can be queried", () => {
    expect(
      getChatAvailability(
        [{ indexingStatus: "failed" }, { indexingStatus: "unindexing" }],
        false,
      ),
    ).toBe("unavailable")
  })

  it("does not disable chat when the readiness check itself fails", () => {
    expect(getChatAvailability(undefined, false)).toBe("ready")
  })
})
