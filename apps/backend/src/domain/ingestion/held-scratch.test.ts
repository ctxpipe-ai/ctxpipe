import { existsSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { heldScratch, holdScratch, releaseScratch } from "./held-scratch.js"

const make = async () => ({
  dir: await mkdtemp(join(tmpdir(), "ctxpipe-held-scratch-")),
})

afterEach(async () => {
  vi.useRealTimers()
  await releaseScratch("test:")
})

describe("held scratch folders", () => {
  it("gives the same folder to each hold of one key, and deletes it at release", async () => {
    const first = await holdScratch("test:a:1", make)
    expect(await holdScratch("test:a:1", make)).toBe(first)
    const sibling = await holdScratch("test:a:10", make)
    expect(heldScratch("test:")).toBe(2)
    await releaseScratch("test:a:1")
    expect(existsSync(first.dir)).toBe(false)
    // A key is exact unless it ends with a colon.
    expect(existsSync(sibling.dir)).toBe(true)
    expect(heldScratch("test:")).toBe(1)
  })

  it("deletes a folder that no one used for an hour at the next new hold, as for a parked or stale holder", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"))
    const parked = await holdScratch("test:parked", make)
    vi.setSystemTime(new Date("2026-10-01T00:59:00Z"))
    const busy = await holdScratch("test:busy", make)
    vi.setSystemTime(new Date("2026-10-01T01:30:00Z"))
    await holdScratch("test:busy", make)
    await holdScratch("test:new", make)
    await vi.waitFor(() => expect(existsSync(parked.dir)).toBe(false))
    expect(existsSync(busy.dir)).toBe(true)
    expect(heldScratch("test:")).toBe(2)
    // A holder that comes back makes its folder again.
    const again = await holdScratch("test:parked", make)
    expect(again.dir).not.toBe(parked.dir)
    expect(existsSync(again.dir)).toBe(true)
  })

  it("does not keep a failed make, so a retry makes the folder again", async () => {
    await expect(
      holdScratch("test:fail", () => Promise.reject(new Error("no remote"))),
    ).rejects.toThrow("no remote")
    expect(heldScratch("test:")).toBe(0)
  })
})
