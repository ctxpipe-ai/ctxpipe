import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { applyRedactedSecretPaths, redactSecretPath } from "./secretPath.js"

/**
 * Same fixtures as `apps/backend/src/observability/logContract.test.ts`.
 * Codesearch keeps its own copy because no shared workspace package fits.
 */
const token = "RVPATHPROBE1790327887NOTASECRET"
const invitationId = "inv_secret_capability"
const liveToken = "RVPATHPROBELIVE1790331095NOTASECRET"
const liveInvitation = "inv_liveprobe_notreal"

const pathFixtures = [
  {
    input: `/.auth/api/v1/auth/reset-password/${token}`,
    expected: "/.auth/api/v1/auth/reset-password/{token}",
    secret: token,
  },
  {
    input: `/.auth/api/v1/public/invitations/${invitationId}`,
    expected: "/.auth/api/v1/public/invitations/{invitation}",
    secret: invitationId,
  },
  {
    input: `https://backend.example/.auth/api/v1/public/invitations/${liveInvitation}`,
    expected:
      "https://backend.example/.auth/api/v1/public/invitations/{invitation}",
    secret: liveInvitation,
  },
  {
    input: `/.auth/api/v1/auth/reset-password/${liveToken}`,
    expected: "/.auth/api/v1/auth/reset-password/{token}",
    secret: liveToken,
  },
]

function implementation(source: string): string {
  const start = source.indexOf("const SECRET_PATH_RULES")
  if (start < 0) throw new Error("SECRET_PATH_RULES missing")
  return source.slice(start).trim()
}

describe("secretPath parity with the backend copy", () => {
  it("keeps the rule table and redaction functions identical", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const codesearch = readFileSync(resolve(here, "secretPath.ts"), "utf8")
    const backend = readFileSync(
      resolve(here, "../../../backend/src/observability/secretPath.ts"),
      "utf8",
    )
    expect(implementation(codesearch)).toBe(implementation(backend))
  })

  it("redacts the same secret path fixtures as the backend log contract", () => {
    for (const fixture of pathFixtures) {
      expect(redactSecretPath(fixture.input)).toBe(fixture.expected)
      expect(redactSecretPath(fixture.input)).not.toContain(fixture.secret)
    }

    const message = {
      step: "oauth.endpoint_error",
      path: `/.auth/api/v1/auth/reset-password/${liveToken}`,
      url: `https://backend.example/.auth/api/v1/public/invitations/${liveInvitation}`,
    }
    const event: Record<string, unknown> = {
      path: `/.auth/api/v1/auth/reset-password/${liveToken}`,
      requestLogs: [
        {
          level: "warn",
          message,
        },
      ],
    }
    applyRedactedSecretPaths(event)
    expect(message.path).toContain(liveToken)
    expect(event.path).toBe("/.auth/api/v1/auth/reset-password/{token}")
    const nested = (
      event.requestLogs as { message: { path: string; url: string } }[]
    )[0]
    expect(nested?.message.path).toBe(
      "/.auth/api/v1/auth/reset-password/{token}",
    )
    expect(nested?.message.url).toBe(
      "https://backend.example/.auth/api/v1/public/invitations/{invitation}",
    )
    expect(JSON.stringify(event)).not.toContain(liveToken)
    expect(JSON.stringify(event)).not.toContain(liveInvitation)
  })

  it("copies frozen objects and skips typed arrays", () => {
    const secretPath = `/.auth/api/v1/auth/reset-password/${liveToken}`
    const frozen = Object.freeze({ path: secretPath })
    const getterOnly = {}
    Object.defineProperty(getterOnly, "path", {
      enumerable: true,
      get() {
        return secretPath
      },
    })
    const bytes = new Uint8Array(5 * 1024 * 1024)
    const started = performance.now()
    const event: Record<string, unknown> = { frozen, getterOnly, bytes }
    applyRedactedSecretPaths(event)
    expect(performance.now() - started).toBeLessThan(250)
    expect(frozen.path).toBe(secretPath)
    expect(event.frozen).not.toBe(frozen)
    expect((event.frozen as { path: string }).path).toBe(
      "/.auth/api/v1/auth/reset-password/{token}",
    )
    expect((event.getterOnly as { path: string }).path).toBe(
      "/.auth/api/v1/auth/reset-password/{token}",
    )
    expect(event.bytes).toBe(bytes)
  })
})
