import { base32nopad } from "@scure/base"
import { describe, expect, it } from "vitest"
import { generateObjectId } from "./id.js"

function readUuidV7TimestampMs(bytes: Uint8Array): bigint {
  return (
    (BigInt(bytes[0] ?? 0) << 40n) |
    (BigInt(bytes[1] ?? 0) << 32n) |
    (BigInt(bytes[2] ?? 0) << 24n) |
    (BigInt(bytes[3] ?? 0) << 16n) |
    (BigInt(bytes[4] ?? 0) << 8n) |
    BigInt(bytes[5] ?? 0)
  )
}

describe("id helpers", () => {
  it("embeds UUIDv7 bytes in generated IDs", () => {
    const before = BigInt(Date.now())
    const id = generateObjectId("repo")
    const after = BigInt(Date.now())
    const bytes = base32nopad.decode(id.slice("repo_".length).toUpperCase())

    expect(bytes).toHaveLength(16)
    expect((bytes[6] ?? 0) >> 4).toBe(0x7)
    expect(((bytes[8] ?? 0) & 0xc0) >> 6).toBe(0x2)

    const timestampMs = readUuidV7TimestampMs(bytes)
    expect(timestampMs >= before).toBe(true)
    expect(timestampMs <= after).toBe(true)
  })

  it("generates object IDs as <prefix>_<base32(uuidv7-bytes)>", () => {
    const id = generateObjectId("repo")
    expect(id.startsWith("repo_")).toBe(true)

    const payload = id.slice("repo_".length)
    expect(payload).toMatch(/^[a-z2-7]+$/)
    expect(payload).toHaveLength(26)

    const decoded = base32nopad.decode(payload.toUpperCase())
    expect(decoded).toHaveLength(16)
    expect((decoded[6] ?? 0) >> 4).toBe(0x7)
    expect(((decoded[8] ?? 0) & 0xc0) >> 6).toBe(0x2)
  })

  it("produces unique IDs across consecutive calls", () => {
    const first = generateObjectId("repo")
    const second = generateObjectId("repo")
    expect(first).not.toBe(second)
  })

  it("keeps UUIDv7 timestamp order for 5 subsequently generated IDs", async () => {
    const timestamps: bigint[] = []
    for (let i = 0; i < 5; i++) {
      const id = generateObjectId("repo")
      const payload = id.slice("repo_".length)
      const bytes = base32nopad.decode(payload.toUpperCase())
      timestamps.push(readUuidV7TimestampMs(bytes))
      await new Promise((resolve) => setTimeout(resolve, 2))
    }

    expect([...timestamps].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(
      timestamps,
    )
  })
})
