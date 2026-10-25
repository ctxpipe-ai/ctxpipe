import { afterEach, expect, it, vi } from "vitest"

import { conversationSandboxProvider } from "./tanstack-workspace-chat.js"

afterEach(() => {
  vi.unstubAllEnvs()
})

it("starts an unsandboxed agent process with only the allow-listed backend variables and the run's own", async () => {
  // A backend variable that no list names, as a new secret would be.
  vi.stubEnv("CTXPIPE_UNLISTED_TEST_SECRET", "secret-value")
  vi.stubEnv("XDG_CONFIG_HOME", "/host/config")
  const provider = conversationSandboxProvider(
    "unsandboxed",
    "agent-password",
    async () => undefined,
  )
  const handle = await provider.create({ id: `unsandboxed-env-${Date.now()}` })
  try {
    await handle.env.set({ XDG_CONFIG_HOME: "/run/config" })
    const result = await handle.process.exec("env")
    expect(result.exitCode).toBe(0)
    const names = new Map(
      result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line]),
    )
    expect(names.has("CTXPIPE_UNLISTED_TEST_SECRET")).toBe(false)
    expect(names.has("AUTH_SECRET")).toBe(false)
    expect(names.has("DATABASE_URL")).toBe(false)
    expect(names.has("PATH")).toBe(true)
    expect(names.get("XDG_CONFIG_HOME")).toBe("XDG_CONFIG_HOME=/run/config")
  } finally {
    await handle.destroy()
  }
})
