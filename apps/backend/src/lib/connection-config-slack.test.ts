import { describe, expect, it } from "vitest"
import type { Env } from "../config/env.js"
import {
  decodeSlackBotToken,
  encodeSlackBotTokenForDb,
  parseSlackConnectionStored,
  serialiseSlackConnectionConfigForDb,
} from "./connection-config.js"

const testEnv = {
  AUTH_SECRET: "a".repeat(32),
  DATABASE_URL: "postgresql://localhost/test",
} as Env

describe("slack connection config", () => {
  it("encrypts and decrypts bot tokens round-trip", () => {
    const enc = encodeSlackBotTokenForDb("xoxb-test-token", testEnv)
    expect(enc.startsWith("ctxv1:")).toBe(true)
    const stored = serialiseSlackConnectionConfigForDb({
      botTokenEnc: enc,
      teamId: "T123",
      teamName: "Acme",
      botUserId: "U456",
      appId: null,
      ownerUserId: null,
      status: "installed",
    })
    const parsed = parseSlackConnectionStored(stored)
    expect(parsed.teamId).toBe("T123")
    expect(decodeSlackBotToken(parsed, testEnv)).toBe("xoxb-test-token")
  })

  it("defaults status to pending", () => {
    const stored = serialiseSlackConnectionConfigForDb({
      botTokenEnc: null,
      teamId: "T1",
      teamName: null,
      botUserId: null,
      appId: null,
      ownerUserId: null,
    })
    expect(parseSlackConnectionStored(stored).status).toBe("pending")
  })
})
