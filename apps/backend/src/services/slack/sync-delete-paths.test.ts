import { describe, expect, it } from "vitest"
import { getSlackDeletePaths } from "./sync.js"

describe("getSlackDeletePaths", () => {
  it("deletes managed paths that are no longer desired", () => {
    expect(
      getSlackDeletePaths({
        managedRepoPaths: [
          "slack/channels/eng--C1/index.md",
          "slack/channels/old--C2/index.md",
        ],
        desiredPaths: new Set(["slack/channels/eng--C1/index.md"]),
        threadsFailed: 0,
      }),
    ).toEqual(["slack/channels/old--C2/index.md"])
  })

  it("skips deletes when any thread failed (partial-failure guard)", () => {
    expect(
      getSlackDeletePaths({
        managedRepoPaths: ["slack/channels/old--C2/index.md"],
        desiredPaths: new Set(),
        threadsFailed: 1,
      }),
    ).toEqual([])
  })
})
