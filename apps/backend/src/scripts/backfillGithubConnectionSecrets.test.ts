import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../config/env.js"

const {
  getSystemDbMock,
  selectMock,
  selectWhereMock,
  updateMock,
  updateWhereMock,
} = vi.hoisted(() => {
  const selectWhereMock = vi.fn()
  const fromMock = vi.fn(() => ({ where: selectWhereMock }))
  const selectMock = vi.fn(() => ({ from: fromMock }))
  const updateWhereMock = vi.fn()
  const setMock = vi.fn(() => ({ where: updateWhereMock }))
  const updateMock = vi.fn(() => ({ set: setMock }))
  return {
    getSystemDbMock: vi.fn(() => ({
      select: selectMock,
      update: updateMock,
    })),
    selectMock,
    selectWhereMock,
    updateMock,
    updateWhereMock,
  }
})

vi.mock("../lib/connection-config.js", () => ({
  encodeGithubAppSecretsForDb: vi.fn(() => ({ privateKeyEnc: "encrypted" })),
  parseGithubConnectionStored: vi.fn(() => ({ installationId: "123" })),
  serialiseGithubConnectionConfigForDb: vi.fn((config) => config),
}))

vi.mock("../db/client.js", () => ({
  getSystemDb: getSystemDbMock,
}))

vi.mock("../observability/logger.js", () => ({
  log: {
    info: vi.fn(),
  },
}))

import { backfillGithubAppSecretsFromEnv } from "./backfillGithubConnectionSecrets.js"

const env = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "ctxpipe-agent",
  GITHUB_PRIVATE_KEY: "private-key",
  GITHUB_WEBHOOK_SECRET: "webhook-secret",
} as Env

describe("backfillGithubAppSecretsFromEnv", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectWhereMock.mockReset()
    updateWhereMock.mockReset()
  })

  it("uses the supplied startup retry policy for its select query", async () => {
    selectWhereMock
      .mockRejectedValueOnce(
        Object.assign(new Error("connect ETIMEDOUT"), {
          code: "ETIMEDOUT",
          syscall: "connect",
        }),
      )
      .mockResolvedValueOnce([])

    await backfillGithubAppSecretsFromEnv(env, {
      retries: 1,
      baseDelayMs: 1,
    })

    expect(selectMock).toHaveBeenCalledTimes(2)
    expect(selectWhereMock).toHaveBeenCalledTimes(2)
  })

  it("uses the supplied startup retry policy for each update query", async () => {
    selectWhereMock.mockResolvedValueOnce([{ id: "con_1", config: {} }])
    updateWhereMock
      .mockRejectedValueOnce(
        Object.assign(new Error("connect ETIMEDOUT"), {
          code: "ETIMEDOUT",
          syscall: "connect",
        }),
      )
      .mockResolvedValueOnce(undefined)

    await backfillGithubAppSecretsFromEnv(env, {
      retries: 1,
      baseDelayMs: 1,
    })

    expect(updateMock).toHaveBeenCalledTimes(2)
    expect(updateWhereMock).toHaveBeenCalledTimes(2)
  })
})
