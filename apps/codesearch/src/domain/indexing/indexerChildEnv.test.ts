import { afterEach, describe, expect, it } from "vitest"
import { withIndexerGoLimits } from "./indexerChildEnv.js"

const originalMax = process.env.GOMAXPROCS
const originalGogc = process.env.GOGC

afterEach(() => {
  if (originalMax === undefined) delete process.env.GOMAXPROCS
  else process.env.GOMAXPROCS = originalMax
  if (originalGogc === undefined) delete process.env.GOGC
  else process.env.GOGC = originalGogc
})

describe("withIndexerGoLimits", () => {
  it("defaults GOMAXPROCS=2 and GOGC=50 when unset", () => {
    delete process.env.GOMAXPROCS
    delete process.env.GOGC
    const env = withIndexerGoLimits()
    expect(env.GOMAXPROCS).toBe("2")
    expect(env.GOGC).toBe("50")
  })

  it("does not override explicit caller or process values", () => {
    process.env.GOMAXPROCS = "8"
    process.env.GOGC = "100"
    expect(withIndexerGoLimits().GOMAXPROCS).toBe("8")
    expect(withIndexerGoLimits({ GOMAXPROCS: "4" }).GOMAXPROCS).toBe("4")
    expect(withIndexerGoLimits({ GOGC: "25" }).GOGC).toBe("25")
  })
})
