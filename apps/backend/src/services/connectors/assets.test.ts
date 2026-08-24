import { describe, expect, it } from "vitest"
import {
  connectorAssetHeadersForHost,
  connectorCommitFileUnchanged,
  consumeConnectorAssetBudget,
  createConnectorAssetBudget,
  downloadConnectorAsset,
  gitBlobSha,
  isPublicConnectorAssetAddress,
  sanitizeConnectorAssetName,
} from "./assets.js"

describe("connector asset boundary", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "::127.0.0.1",
    "64:ff9b::127.0.0.1",
    "100::1",
    "2001::1",
    "2002:7f00:1::",
    "3fff::1",
    "5f00::1",
    "fec0::1",
    "4000::1",
    "fe00::1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicConnectorAssetAddress(address)).toBe(false)
  })

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
  ])("accepts public address %s", (address) => {
    expect(isPublicConnectorAssetAddress(address)).toBe(true)
  })

  it("sanitises provider filenames without losing a useful extension", () => {
    expect(sanitizeConnectorAssetName("../../Architecture diagram.PNG")).toBe(
      "architecture-diagram.png",
    )
    expect(sanitizeConnectorAssetName("")).toBe("attachment")
  })

  it("enforces both per-asset and per-entity budgets", () => {
    const budget = createConnectorAssetBudget({
      maxAssetBytes: 25,
      maxEntityBytes: 40,
    })

    expect(consumeConnectorAssetBudget(budget, 20)).toEqual({
      ok: true,
      remainingBytes: 20,
    })
    expect(consumeConnectorAssetBudget(budget, 21)).toEqual({
      ok: false,
      reason: "entity_limit",
      remainingBytes: 20,
    })
    expect(consumeConnectorAssetBudget(budget, 26)).toEqual({
      ok: false,
      reason: "asset_limit",
      remainingBytes: 20,
    })
  })

  it("computes the canonical git blob sha for binary no-op detection", () => {
    expect(gitBlobSha(Buffer.from("hello"))).toBe(
      "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0",
    )
  })

  it("compares both text and binary commit files by canonical git blob sha", () => {
    const text = { path: "thread.md", content: "hello" }
    const binary = {
      path: "assets/image.png",
      content: Buffer.from("hello").toString("base64"),
      encoding: "base64" as const,
    }
    const existing = new Map([
      ["thread.md", gitBlobSha(Buffer.from("hello"))],
      ["assets/image.png", gitBlobSha(Buffer.from("hello"))],
    ])

    expect(connectorCommitFileUnchanged(text, existing)).toBe(true)
    expect(connectorCommitFileUnchanged(binary, existing)).toBe(true)
  })

  it("strips provider credentials from untrusted redirect hosts", () => {
    const headers = { authorization: "Bearer secret" }
    expect(
      connectorAssetHeadersForHost({
        hostname: "files.slack.com",
        credentialHost: "files.slack.com",
        headers,
        authenticatedHosts: ["files.slack.com"],
      }),
    ).toEqual(headers)
    expect(
      connectorAssetHeadersForHost({
        hostname: "cdn.example.com",
        credentialHost: "files.slack.com",
        headers,
        authenticatedHosts: ["files.slack.com", "cdn.example.com"],
      }),
    ).toEqual({})
  })

  it.each([
    ["not a url", "invalid_url"],
    ["http://example.com/file.png", "unsafe_url"],
    ["https://user:secret@example.com/file.png", "unsafe_url"],
    ["https://example.com:8443/file.png", "unsafe_url"],
    ["https://[::1]/file.png", "unsafe_url"],
  ] as const)("rejects unsafe source URL %s", async (url, reason) => {
    await expect(
      downloadConnectorAsset({
        url,
        budget: createConnectorAssetBudget(),
      }),
    ).resolves.toEqual({ status: "stub", reason })
  })
})
