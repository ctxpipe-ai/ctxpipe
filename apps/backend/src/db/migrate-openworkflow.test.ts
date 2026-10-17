import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { connect, stop } = vi.hoisted(() => {
  const stop = vi.fn()
  const connect = vi.fn(async () => ({ stop }))
  return { connect, stop }
})

vi.mock("openworkflow/postgres", () => ({
  BackendPostgres: { connect },
}))

import { runMigrateOpenWorkflowFromEnv } from "./migrate-openworkflow.js"

describe("runMigrateOpenWorkflowFromEnv", () => {
  const previousAuthSecret = process.env.AUTH_SECRET

  beforeEach(() => {
    connect.mockClear()
    stop.mockClear()
    delete process.env.AUTH_SECRET
  })

  afterEach(() => {
    if (previousAuthSecret === undefined) delete process.env.AUTH_SECRET
    else process.env.AUTH_SECRET = previousAuthSecret
  })

  it("migrates with DATABASE_URL and no AUTH_SECRET", async () => {
    await runMigrateOpenWorkflowFromEnv({
      DATABASE_URL: "postgresql://ctxpipe:ctxpipe@127.0.0.1:5432/ctxpipe",
    })
    expect(connect).toHaveBeenCalledWith(
      "postgresql://ctxpipe:ctxpipe@127.0.0.1:5432/ctxpipe",
      { runMigrations: true },
    )
    expect(stop).toHaveBeenCalled()
  })

  it("requires DATABASE_URL", async () => {
    await expect(runMigrateOpenWorkflowFromEnv({})).rejects.toThrow(
      "DATABASE_URL is required",
    )
    expect(connect).not.toHaveBeenCalled()
  })
})
