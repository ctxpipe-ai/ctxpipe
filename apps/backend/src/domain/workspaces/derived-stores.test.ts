import { describe, expect, it, vi } from "vitest"
import { embedHydrateUnits } from "./derived-stores.js"

describe("embedHydrateUnits", () => {
  it("returns embeddings without throwing when the embedder fails", async () => {
    await expect(
      embedHydrateUnits({
        units: [
          {
            path: "knowledge/a.md",
            servingId: "kn_a",
            body: "Hello",
            links: [],
            claims: [],
          },
        ],
        embed: async () => {
          throw new Error("upstream down")
        },
      }),
    ).resolves.toEqual([])
  })

  it("pairs vectors to serving ids", async () => {
    const embed = vi.fn().mockResolvedValue([[0.1, 0.2]])
    await expect(
      embedHydrateUnits({
        units: [
          {
            path: "knowledge/a.md",
            servingId: "kn_a",
            body: "Hello",
            links: [],
            claims: [],
          },
        ],
        embed,
      }),
    ).resolves.toEqual([{ servingId: "kn_a", embedding: [0.1, 0.2] }])
  })
})
