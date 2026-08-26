import { describe, expect, it, vi } from "vitest"
import {
  canonicalConnectorAssetUrl,
  connectorAssetHeadersForHost,
  connectorAssetPinnedTlsOptions,
  connectorAssetRetryDelayMs,
  connectorCommitFileUnchanged,
  connectorPathMatchesPreservation,
  consumeConnectorAssetBudget,
  consumeConnectorAssetBytePool,
  consumeConnectorAssetTransferBytes,
  createConnectorAssetBudget,
  createConnectorAssetBytePool,
  createPinnedConnectorAssetLookup,
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
    "198.51.100.1",
    "203.0.113.1",
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
    "198.51.99.1",
    "203.0.112.1",
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

  it("removes recognised signed-URL credentials without aliasing generic queries", () => {
    expect(
      canonicalConnectorAssetUrl(
        "https://cdn.example.com/image.png?X-Amz-Expires=60&X-Amz-Signature=secret&X-Amz-Credential=key#preview",
      ),
    ).toBe("https://cdn.example.com/image.png")
    expect(
      canonicalConnectorAssetUrl(
        "https://cdn.example.com/image.png?token=first",
      ),
    ).not.toBe(
      canonicalConnectorAssetUrl(
        "https://cdn.example.com/image.png?token=second",
      ),
    )
    expect(
      canonicalConnectorAssetUrl("https://cdn.example.com/image.png?sig=first"),
    ).not.toBe(
      canonicalConnectorAssetUrl(
        "https://cdn.example.com/image.png?sig=second",
      ),
    )
    expect(
      canonicalConnectorAssetUrl(
        "https://storage.example.com/blob?comp=range&sv=2025-01-05&spr=https&st=2026-08-25T00%3A00Z&se=2026-08-26T00%3A00Z&sp=r&sig=secret",
      ),
    ).toBe("https://storage.example.com/blob?comp=range")
    expect(
      canonicalConnectorAssetUrl(
        "https://storage.googleapis.com/bucket/image.png?GoogleAccessId=service%40example.com&Expires=1787600000&Signature=first",
      ),
    ).toBe("https://storage.googleapis.com/bucket/image.png")
    expect(
      canonicalConnectorAssetUrl(
        "https://cdn.example.com/image?id=second&format=png",
      ),
    ).toBe("https://cdn.example.com/image?format=png&id=second")
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

  it("exhausts the transfer budget when a received chunk crosses the cap", () => {
    const budget = createConnectorAssetBudget({ maxEntityBytes: 3 })

    expect(consumeConnectorAssetTransferBytes(budget, 4)).toBe(false)
    expect(budget.remainingBytes).toBe(0)
    expect(consumeConnectorAssetTransferBytes(budget, 1)).toBe(false)
  })

  it("caps retained binary bytes across a full sync", () => {
    const pool = createConnectorAssetBytePool(10)
    expect(consumeConnectorAssetBytePool(pool, 6)).toBe(true)
    expect(consumeConnectorAssetBytePool(pool, 5)).toBe(false)
    expect(pool.remainingBytes).toBe(4)
    expect(pool.remainingAssets).toBe(249)
  })

  it("caps retained binary file count across a full sync", () => {
    const pool = createConnectorAssetBytePool(100, 1)
    expect(consumeConnectorAssetBytePool(pool, 1)).toBe(true)
    expect(consumeConnectorAssetBytePool(pool, 1)).toBe(false)
    expect(pool.remainingAssets).toBe(0)
    expect(pool.remainingBytes).toBe(99)
  })

  it("honours Retry-After unless the entity deadline rejects the wait", () => {
    expect(
      connectorAssetRetryDelayMs(0, {
        headers: { "retry-after": "30" },
      }),
    ).toBe(30_000)
  })

  it("bounds failed candidates and the total entity download window", async () => {
    const oneCandidate = createConnectorAssetBudget({
      maxAssets: 1,
      maxDurationMs: 60_000,
    })
    await expect(
      downloadConnectorAsset({
        url: "http://example.com/first.png",
        budget: oneCandidate,
      }),
    ).resolves.toEqual({ status: "stub", reason: "unsafe_url" })
    await expect(
      downloadConnectorAsset({
        url: "http://example.com/second.png",
        budget: oneCandidate,
      }),
    ).resolves.toEqual({ status: "stub", reason: "entity_limit" })

    await expect(
      downloadConnectorAsset({
        url: "https://example.com/too-late.png",
        budget: createConnectorAssetBudget({ maxDurationMs: 0 }),
      }),
    ).resolves.toEqual({ status: "stub", reason: "entity_limit" })
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

  it("distinguishes exact retained paths from explicit path prefixes", () => {
    expect(
      connectorPathMatchesPreservation(
        "assets/file.png.backup",
        "assets/file.png",
      ),
    ).toBe(false)
    expect(
      connectorPathMatchesPreservation(
        "assets/source--renamed.png",
        "assets/source--",
      ),
    ).toBe(true)
    expect(
      connectorPathMatchesPreservation("assets/nested/file.png", "assets/"),
    ).toBe(true)
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

  it("pins the socket address while keeping TLS verification explicit", () => {
    const options = connectorAssetPinnedTlsOptions({
      hostname: "files.example.com",
      address: "1.1.1.1",
      family: 4,
    })
    expect(options).toMatchObject({
      rejectUnauthorized: true,
      servername: "files.example.com",
    })
    expect(options.lookup).toBeTypeOf("function")
  })

  it("returns the callback shape requested by Node and Bun HTTPS", () => {
    const pinnedLookup = createPinnedConnectorAssetLookup({
      address: "1.1.1.1",
      family: 4,
    })
    const scalarCallback = vi.fn()
    const allCallback = vi.fn()

    pinnedLookup("files.example.com", 0, scalarCallback)
    pinnedLookup("files.example.com", { all: true }, allCallback)

    expect(scalarCallback).toHaveBeenCalledWith(null, "1.1.1.1", 4)
    expect(allCallback).toHaveBeenCalledWith(null, [
      { address: "1.1.1.1", family: 4 },
    ])
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
