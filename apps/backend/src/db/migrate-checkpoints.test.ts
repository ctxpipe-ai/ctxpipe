import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { setup, end } = vi.hoisted(() => {
  const setup = vi.fn()
  const end = vi.fn()
  return { setup, end }
})

vi.mock("pg", () => ({
  Pool: class {
    end() {
      return end()
    }
  },
}))

vi.mock("@langchain/langgraph-checkpoint-postgres", () => ({
  PostgresSaver: class {
    setup() {
      return setup()
    }
  },
}))

import { runMigrateLanggraphCheckpointsFromEnv } from "./migrate-checkpoints.js"

describe("runMigrateLanggraphCheckpointsFromEnv", () => {
  beforeEach(() => {
    setup.mockClear()
    end.mockClear()
  })

  afterEach(() => {
    setup.mockReset()
    end.mockReset()
  })

  it("runs PostgresSaver.setup on DATABASE_URL and closes the pool", async () => {
    await runMigrateLanggraphCheckpointsFromEnv({
      DATABASE_URL: "postgresql://ctxpipe:ctxpipe@127.0.0.1:5432/ctxpipe",
    })
    expect(setup).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
  })

  it("requires DATABASE_URL", async () => {
    await expect(runMigrateLanggraphCheckpointsFromEnv({})).rejects.toThrow(
      "DATABASE_URL is required",
    )
    expect(setup).not.toHaveBeenCalled()
  })
})
