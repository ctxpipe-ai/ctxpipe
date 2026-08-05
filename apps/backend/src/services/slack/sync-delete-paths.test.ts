import { describe, expect, it } from "vitest"
import { getSlackThreadDirPath } from "./converter.js"
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

describe("getSlackThreadDirPath", () => {
  it("groups thread markdown and assets under one directory", () => {
    const dir = getSlackThreadDirPath({
      channelId: "C1",
      channelName: "eng",
      threadTs: "1700000000.000100",
    })
    expect(dir).toBe(
      "slack/channels/eng--C1/threads/2023/11/1700000000.000100",
    )
  })
})
