import { describe, expect, it } from "vitest"
import {
  createDeltaMasker,
  maskCredentials,
  maskCredentialsDeep,
} from "./mask-credentials.js"

// Made-up values in the shape of real credentials.
const fill = (length: number) => "a1B2c3D4e5".repeat(8).slice(0, length)

describe("maskCredentials", () => {
  it.each([
    ["ghs_", `token ghs_${fill(36)} end`],
    ["ghp_", `export GH_TOKEN=ghp_${fill(36)}`],
    ["gho_", `gho_${fill(36)}`],
    ["ghu_", `"ghu_${fill(36)}"`],
    ["ghr_", `see ghr_${fill(76)}`],
    ["github_pat_", `github_pat_${fill(22)}_${fill(59)}`],
    ["sk- key", `OPENAI_API_KEY=sk-${fill(40)}`],
    ["sk-ant- key", `key: sk-ant-api03-${fill(60)}`],
  ])("masks a %s token", (_kind, text) => {
    const masked = maskCredentials(text)
    expect(masked).toContain("[masked]")
    expect(masked).not.toContain(fill(20))
  })

  it("masks a GitHub App installation token in the current form (CTX-845)", () => {
    // A numeric id, a second underscore, and a value with "_", "." and "-".
    const token = `ghs_${"1234567"}_${"Ab3dE_f6Gh-9jKmN2pQ"}.${"rS5tU-v8Wx_y1Z"}.${"c4De-F7gH_i0Jk"}`
    expect(maskCredentials(`token ${token} end.`)).toBe("token [masked] end.")
    expect(maskCredentials(`GH_TOKEN=${token}.`)).toBe("GH_TOKEN=[masked].")
  })

  it("keeps short names and identifiers that start like a GitHub token", () => {
    for (const text of [
      "The ghs_foo prefix marks an installation token.",
      "const ghs_count_total_for_each_repository_owner = 0",
      "see ghs_12_build.log",
    ])
      expect(maskCredentials(text)).toBe(text)
  })

  it("masks a password with an empty user name", () => {
    expect(maskCredentials("redis://:hunter2secret@cache:6379")).toBe(
      "redis://[masked]@cache:6379",
    )
  })

  it("masks a run capability in the shape the backend mints", () => {
    const payload = Buffer.from(
      JSON.stringify({ exp: 1, orgId: "org_x", purpose: "p" }),
    ).toString("base64url")
    const capability = `${payload}.${"s".repeat(43)}`
    expect(maskCredentials(`TOKEN=${capability} next`)).toBe(
      "TOKEN=[masked] next",
    )
  })

  it("keeps prose and code that only name a credential", () => {
    for (const text of [
      "Use Bearer authentication for the API.",
      "const requireAuthorization = true",
      "type Headers = { authorization: string }",
      "The Authorization header is optional.",
    ])
      expect(maskCredentials(text)).toBe(text)
  })

  it("keeps escaped JSON valid", () => {
    const args = JSON.stringify({
      command: `curl -H "Authorization: Bearer ${fill(30)}" -H "Authorization: token ${fill(24)}" https://u:${fill(20)}@h.example/x`,
    })
    const masked = maskCredentials(args)
    expect(masked).not.toContain(fill(20))
    expect(JSON.parse(masked)).toEqual({
      command:
        'curl -H "Authorization: [masked]" -H "Authorization: [masked]" https://[masked]@h.example/x',
    })
  })

  it("masks one megabyte of letters and hex quickly", () => {
    const letters = "abcdefghijklmnopqrstuvwxyz".repeat(20_000)
    const hex = "0123456789abcdef".repeat(32_000)
    const started = performance.now()
    maskCredentials(letters + hex)
    maskCredentials(`${"a".repeat(500_000)}:${"b".repeat(500_000)}`)
    expect(performance.now() - started).toBeLessThan(50)
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

describe("createDeltaMasker", () => {
  it("masks a token split over many small deltas", () => {
    const token = `ghp_${fill(36)}`
    const text = `${"Some words before. ".repeat(10)}The token is ${token} and more text after it. ${"Words. ".repeat(30)}`
    const masker = createDeltaMasker()
    let out = ""
    for (let index = 0; index < text.length; index += 3)
      out += masker.push(text.slice(index, index + 3))
    out += masker.flush()
    expect(out).toBe(maskCredentials(text))
    expect(out).not.toContain(fill(10))
  })

  it("keeps a Bearer scheme and its value together", () => {
    const text = `${"x ".repeat(60)}Authorization: Bearer ${fill(40)} ${"y ".repeat(60)}`
    const masker = createDeltaMasker()
    let out = ""
    for (const char of text) out += masker.push(char)
    out += masker.flush()
    expect(out).toBe(maskCredentials(text))
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
