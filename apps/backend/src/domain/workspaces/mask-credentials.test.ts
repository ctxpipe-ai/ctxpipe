import { describe, expect, it } from "vitest"
import { maskCredentials, maskCredentialsDeep } from "./mask-credentials.js"

// Made-up values in the shape of real credentials.
const fill = (length: number) => "a1B2c3D4e5".repeat(8).slice(0, length)

describe("maskCredentials", () => {
  it.each([
    ["ghs_", `token ghs_${fill(36)} end`],
    ["ghp_", `export GH_TOKEN=ghp_${fill(36)}`],
    ["gho_", `gho_${fill(36)}`],
    ["ghu_", `"ghu_${fill(36)}"`],
    ["github_pat_", `github_pat_${fill(22)}_${fill(59)}`],
    ["sk- key", `OPENAI_API_KEY=sk-${fill(40)}`],
    ["sk-ant- key", `key: sk-ant-api03-${fill(60)}`],
  ])("masks a %s token", (_kind, text) => {
    const masked = maskCredentials(text)
    expect(masked).toContain("[masked]")
    expect(masked).not.toContain(fill(20))
  })

  it("masks a Bearer token and keeps the scheme", () => {
    expect(maskCredentials(`curl -H "x: Bearer ${fill(30)}" api`)).toBe(
      'curl -H "x: Bearer [masked]" api',
    )
  })

  it("masks the whole Authorization header value", () => {
    expect(
      maskCredentials(`curl -H "Authorization: Basic ${fill(24)}" url`),
    ).toBe('curl -H "Authorization: [masked]" url')
    expect(maskCredentials(`authorization: token ${fill(20)}\nnext`)).toBe(
      "authorization: [masked]\nnext",
    )
  })

  it("masks user and password in URLs", () => {
    expect(
      maskCredentials(
        `git clone https://x-access-token:${fill(30)}@github.com/o/r.git`,
      ),
    ).toBe("git clone https://[masked]@github.com/o/r.git")
    expect(maskCredentials("postgres://app:hunter2@db:5432/x")).toBe(
      "postgres://[masked]@db:5432/x",
    )
    expect(maskCredentials(`x-access-token:${fill(30)}@github.com`)).toBe(
      "[masked]@github.com",
    )
  })

  it("keeps ordinary text", () => {
    const text =
      "Read knowledge/billing/ledger.md, ask-me later, https://github.com/o/r and user@example.com"
    expect(maskCredentials(text)).toBe(text)
  })
})

describe("maskCredentialsDeep", () => {
  it("masks strings in nested chunks and messages and keeps other values", () => {
    const createdAt = new Date("2026-10-11T00:00:00.000Z")
    const masked = maskCredentialsDeep({
      type: "TOOL_CALL_ARGS",
      delta: `{"command":"echo ghp_${fill(36)}"}`,
      parts: [{ content: `Bearer ${fill(30)}`, count: 3 }],
      createdAt,
      done: true,
    })
    expect(masked).toEqual({
      type: "TOOL_CALL_ARGS",
      delta: '{"command":"echo [masked]"}',
      parts: [{ content: "Bearer [masked]", count: 3 }],
      createdAt,
      done: true,
    })
    expect(masked.createdAt).toBe(createdAt)
  })
})
