import { afterEach, describe, expect, it, vi } from "vitest"
import { createBetterAuth } from "./config.js"

describe("createBetterAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("allows emailed invitations with opaque custom IDs to be accepted", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/ctxpipe")
    vi.stubEnv(
      "AUTH_SECRET",
      "test-only-auth-secret-with-at-least-32-characters",
    )
    vi.stubEnv("AUTH_BASE_URL", "http://localhost:3000")

    const auth = createBetterAuth()
    const organizationPlugin = auth.options.plugins?.find(
      (plugin) => plugin.id === "organization",
    )

    expect(organizationPlugin).toBeDefined()
    expect(organizationPlugin?.options).toMatchObject({
      requireEmailVerificationOnInvitation: false,
    })
  })
})
