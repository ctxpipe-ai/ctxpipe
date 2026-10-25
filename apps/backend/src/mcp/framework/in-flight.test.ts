import { describe, expect, it } from "vitest"

import { MAX_IN_FLIGHT_PER_PRINCIPAL, withInFlightLimit } from "./in-flight.js"

function gate() {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

describe("withInFlightLimit", () => {
  it("allows a burst of 8 parallel calls and refuses the ninth", async () => {
    expect(MAX_IN_FLIGHT_PER_PRINCIPAL).toBe(8)
    const { opened, open } = gate()
    const running = Array.from({ length: 8 }, (_, index) =>
      withInFlightLimit("user:burst", async () => {
        await opened
        return index
      }),
    )
    await expect(
      withInFlightLimit("user:burst", async () => "ninth"),
    ).rejects.toMatchObject({ code: "too_many_requests", retryable: true })
    open()
    expect(await Promise.all(running)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    await expect(
      withInFlightLimit("user:burst", async () => "after"),
    ).resolves.toBe("after")
  })

  it("counts each principal on its own", async () => {
    const { opened, open } = gate()
    const running = Array.from({ length: 2 }, () =>
      withInFlightLimit("user:a", () => opened, 2),
    )
    await expect(withInFlightLimit("user:b", async () => "b", 2)).resolves.toBe(
      "b",
    )
    await expect(
      withInFlightLimit("user:a", async () => "a", 2),
    ).rejects.toMatchObject({
      code: "too_many_requests",
    })
    open()
    await Promise.all(running)
  })

  it("frees the slot when the call fails", async () => {
    await expect(
      withInFlightLimit(
        "user:fail",
        async () => {
          throw new Error("boom")
        },
        1,
      ),
    ).rejects.toThrow("boom")
    await expect(
      withInFlightLimit("user:fail", async () => "ok", 1),
    ).resolves.toBe("ok")
  })
})
