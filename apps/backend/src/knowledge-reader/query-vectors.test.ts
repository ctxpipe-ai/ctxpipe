import { describe, expect, it } from "vitest"

import { queryVector } from "./query-vectors.js"

/** An embed function that counts its calls. */
function counted(vector: number[]) {
  const embed = async () => {
    embed.calls += 1
    return vector
  }
  embed.calls = 0
  return embed
}

describe("queryVector", () => {
  it("keeps the vector of an org and a text, so the second call makes no embedding call", async () => {
    const embed = counted([0.1, 0.2])
    expect(await queryVector("org_kept_a", "who owns checkout", embed)).toEqual(
      [0.1, 0.2],
    )
    expect(await queryVector("org_kept_a", "who owns checkout", embed)).toEqual(
      [0.1, 0.2],
    )
    expect(embed.calls).toBe(1)
    // Another text is another call.
    await queryVector("org_kept_a", "who owns payments", embed)
    expect(embed.calls).toBe(2)
  })

  it("never gives one org the vector that another org asked for", async () => {
    const embed = counted([0.3])
    await queryVector("org_wall_a", "the same text", embed)
    await queryVector("org_wall_b", "the same text", embed)
    expect(embed.calls).toBe(2)
  })

  it("keeps nothing for a failed call", async () => {
    const failing = async (): Promise<number[]> => {
      throw new Error("busy")
    }
    await expect(
      queryVector("org_failed", "a failed text", failing),
    ).rejects.toThrow("busy")
    const embed = counted([0.4])
    await queryVector("org_failed", "a failed text", embed)
    expect(embed.calls).toBe(1)
  })

  it("keeps the 256 newest vectors: a use makes a vector new again", async () => {
    const embed = counted([0.5])
    await queryVector("org_lru", "text 0", embed)
    for (let i = 1; i < 256; i++)
      await queryVector("org_lru", `text ${i}`, embed)
    // "text 0" is the oldest; a use makes it the newest.
    await queryVector("org_lru", "text 0", embed)
    expect(embed.calls).toBe(256)
    // One more text removes the oldest: "text 1".
    await queryVector("org_lru", "text 256", embed)
    await queryVector("org_lru", "text 0", embed)
    expect(embed.calls).toBe(257)
    await queryVector("org_lru", "text 1", embed)
    expect(embed.calls).toBe(258)
  })
})
