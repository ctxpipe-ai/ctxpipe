import { describe, expect, it } from "vitest"
import { resolveEmailVerificationUrl } from "./verification-email-url.js"

describe("resolveEmailVerificationUrl", () => {
  it("rewrites Better Auth verify-email URL to mounted auth basePath", () => {
    const result = resolveEmailVerificationUrl(
      "https://app.ctxpipe.localhost:1355",
      "https://app.ctxpipe.localhost:1355/verify-email?token=abc123&callbackURL=%2Fonboarding",
    )

    expect(result).toBe(
      "https://app.ctxpipe.localhost:1355/.auth/api/v1/auth/verify-email?token=abc123&callbackURL=%2Fonboarding",
    )
  })
})
