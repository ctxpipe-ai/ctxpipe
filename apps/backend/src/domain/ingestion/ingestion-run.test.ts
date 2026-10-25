import { describe, expect, it } from "vitest"

import { ingestionV2Status } from "./ingestion-run.js"

describe("ingestion v2 run status", () => {
  it("is done when no Workspace is refused or partial", () => {
    expect(ingestionV2Status([{ partial: 0 }, { partial: 0 }])).toBe("done")
  })

  it("is partial when the broker refused a Workspace's assemble", () => {
    expect(
      ingestionV2Status([
        { partial: 0 },
        {
          partial: 1,
          refused: "The semantic merge result fails the patch validator",
        },
      ]),
    ).toBe("partial")
    expect(
      ingestionV2Status([{ partial: 0, refused: "The shard ref moved" }]),
    ).toBe("partial")
  })

  it("is partial when a step of a Workspace is partial", () => {
    expect(ingestionV2Status([{ partial: 2 }])).toBe("partial")
  })
})
