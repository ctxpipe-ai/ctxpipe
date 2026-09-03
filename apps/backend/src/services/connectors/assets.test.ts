import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const network = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
}))

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>()
  return { ...actual, lookup: network.lookup }
})

vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https")>()
  return { ...actual, request: network.request }
})

import {
  canonicalConnectorAssetUrl,
  connectorAssetDownloadLimit,
  connectorAssetHeadersForHost,
  connectorAssetPinnedTlsOptions,
  connectorAssetRetryDelayMs,
  connectorCommitFileUnchanged,
  connectorPathMatchesPreservation,
  consumeConnectorAssetBytePool,
  consumeConnectorAssetTransferBytes,
  createConnectorAssetBudget,
  createConnectorAssetBytePool,
  createConnectorEntityAssetBytePool,
  createPinnedConnectorAssetLookup,
  downloadConnectorAsset,
  gitBlobSha,
  isConnectorAssetCredentialUrl,
  isPublicConnectorAssetAddress,
  sanitizeConnectorAssetName,
  withConnectorAssetBytePoolRollback,
} from "./assets.js"

type HttpsResponsePlan = {
  status: number
  headers?: Record<string, string>
  chunks?: Array<string | Buffer>
}

function mockHttpsResponses(...plans: HttpsResponsePlan[]) {
  network.request.mockImplementation(
    (
      _url: URL,
      _options: Record<string, unknown>,
      onResponse: (
        response: PassThrough & {
          statusCode: number
          headers: Record<string, string>
        },
      ) => void,
    ) => {
      const plan = plans.shift()
      if (!plan) throw new Error("Unexpected connector asset request")

      const request = new EventEmitter() as EventEmitter & {
        destroy: (error?: Error) => void
        end: () => void
        setTimeout: (timeoutMs: number, callback: () => void) => void
      }
      request.setTimeout = vi.fn()
      request.destroy = vi.fn((error?: Error) => {
        if (error) queueMicrotask(() => request.emit("error", error))
      })
      request.end = vi.fn(() => {
        const response = new PassThrough() as PassThrough & {
          statusCode: number
          headers: Record<string, string>
        }
        response.statusCode = plan.status
        response.headers = plan.headers ?? {}
        onResponse(response)
        queueMicrotask(() => {
          for (const chunk of plan.chunks ?? []) response.write(chunk)
          response.end()
        })
      })
      return request
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  network.lookup.mockImplementation(async (hostname: string) =>
    hostname === "::1"
      ? [{ address: "::1", family: 6 }]
      : [{ address: "1.1.1.1", family: 4 }],
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe("connector asset boundary", () => {
  it("delivers provider credentials only to the authenticated source host", async () => {
    mockHttpsResponses({
      status: 200,
      headers: { "content-type": "image/png" },
      chunks: ["image-bytes"],
    })

    await expect(
      downloadConnectorAsset({
        url: "https://files.provider.example/diagram.png",
        budget: createConnectorAssetBudget(),
        headers: { authorization: "Bearer provider-secret" },
        authenticatedHosts: ["files.provider.example"],
      }),
    ).resolves.toMatchObject({
      status: "downloaded",
      bytes: Buffer.from("image-bytes"),
      contentType: "image/png",
    })

    expect(network.request).toHaveBeenCalledWith(
      new URL("https://files.provider.example/diagram.png"),
      expect.objectContaining({
        headers: {
          "accept-encoding": "identity",
          authorization: "Bearer provider-secret",
        },
        rejectUnauthorized: true,
        servername: "files.provider.example",
      }),
      expect.any(Function),
    )
  })

  it("strips provider credentials before following a cross-origin redirect", async () => {
    mockHttpsResponses(
      {
        status: 302,
        headers: { location: "https://cdn.example/diagram.png" },
      },
      {
        status: 200,
        headers: { "content-type": "image/png" },
        chunks: ["redirected-image"],
      },
    )

    await expect(
      downloadConnectorAsset({
        url: "https://files.provider.example/diagram.png",
        budget: createConnectorAssetBudget(),
        headers: { authorization: "Bearer must-not-cross-hosts" },
        authenticatedHosts: ["files.provider.example"],
      }),
    ).resolves.toMatchObject({
      status: "downloaded",
      bytes: Buffer.from("redirected-image"),
    })

    expect(network.request).toHaveBeenCalledTimes(2)
    expect(network.request.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: { "accept-encoding": "identity" },
        servername: "cdn.example",
      }),
    )
  })

  it("revalidates redirect DNS and rejects a private destination before connecting", async () => {
    network.lookup.mockImplementation(async (hostname: string) =>
      hostname === "files.provider.example"
        ? [{ address: "1.1.1.1", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }],
    )
    mockHttpsResponses({
      status: 302,
      headers: { location: "https://internal.example/metadata" },
    })

    await expect(
      downloadConnectorAsset({
        url: "https://files.provider.example/diagram.png",
        budget: createConnectorAssetBudget(),
      }),
    ).resolves.toEqual({ status: "stub", reason: "unsafe_url" })
    expect(network.request).toHaveBeenCalledTimes(1)
  })

  it("rejects a hostname when any resolved address is non-public", async () => {
    network.lookup.mockResolvedValue([
      { address: "1.1.1.1", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ])

    await expect(
      downloadConnectorAsset({
        url: "https://mixed-dns.example/diagram.png",
        budget: createConnectorAssetBudget(),
      }),
    ).resolves.toEqual({ status: "stub", reason: "unsafe_url" })
    expect(network.request).not.toHaveBeenCalled()
  })

  it.each([
    {
      limits: { maxAssetBytes: 6, maxEntityBytes: 10 },
      reason: "asset_limit",
    },
    {
      limits: { maxAssetBytes: 10, maxEntityBytes: 6 },
      reason: "entity_limit",
    },
  ] as const)("enforces the streamed $reason before retaining an oversized response", async ({
    limits,
    reason,
  }) => {
    mockHttpsResponses({
      status: 200,
      chunks: [Buffer.alloc(4), Buffer.alloc(4)],
    })

    await expect(
      downloadConnectorAsset({
        url: "https://cdn.example/large.bin",
        budget: createConnectorAssetBudget(limits),
      }),
    ).resolves.toEqual({ status: "stub", reason })
  })

  it("bounds a DNS lookup that outlives the entity deadline", async () => {
    vi.useFakeTimers()
    network.lookup.mockImplementation(() => new Promise(() => undefined))

    const result = downloadConnectorAsset({
      url: "https://slow-dns.example/diagram.png",
      budget: createConnectorAssetBudget({ maxDurationMs: 25 }),
    })
    await vi.advanceTimersByTimeAsync(25)

    await expect(result).resolves.toEqual({
      status: "stub",
      reason: "entity_limit",
    })
    expect(network.request).not.toHaveBeenCalled()
  })

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
      canonicalConnectorAssetUrl(
        "https://cdn.example.com/image.png?token=first&width=640",
        { stripGenericCredentials: true },
      ),
    ).toBe("https://cdn.example.com/image.png?width=640")
    expect(
      isConnectorAssetCredentialUrl(
        "https://cdn.example.com/image.png?token=secret",
        { includeGenericCredentials: true },
      ),
    ).toBe(true)
    expect(
      isConnectorAssetCredentialUrl(
        "https://cdn.example.com/image.png?version=1",
        { includeGenericCredentials: true },
      ),
    ).toBe(false)
    expect(
      isConnectorAssetCredentialUrl(
        "https://temporary-user:temporary-password@cdn.example.com/image.png",
      ),
    ).toBe(true)
    expect(
      canonicalConnectorAssetUrl(
        "https://temporary-user:temporary-password@cdn.example.com/image.png",
      ),
    ).toBe("https://cdn.example.com/image.png")
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

  it("classifies the binding byte limit before transfer mutates the budget", () => {
    expect(
      connectorAssetDownloadLimit(
        createConnectorAssetBudget({
          maxAssetBytes: 25,
          maxEntityBytes: 40,
        }),
      ),
    ).toEqual({ maxBytes: 25, exceededReason: "asset_limit" })
    expect(
      connectorAssetDownloadLimit(
        createConnectorAssetBudget({
          maxAssetBytes: 25,
          maxEntityBytes: 20,
        }),
      ),
    ).toEqual({ maxBytes: 20, exceededReason: "entity_limit" })
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

  it("retains up to the 100 MiB entity limit during incremental sync", () => {
    const pool = createConnectorEntityAssetBytePool()
    const twentyThreeMiB = 23 * 1024 * 1024

    expect(consumeConnectorAssetBytePool(pool, twentyThreeMiB)).toBe(true)
    expect(consumeConnectorAssetBytePool(pool, twentyThreeMiB)).toBe(true)
    expect(consumeConnectorAssetBytePool(pool, twentyThreeMiB)).toBe(true)
    expect(pool.remainingBytes).toBe(31 * 1024 * 1024)
    expect(pool.remainingAssets).toBe(97)
  })

  it("rolls back retained-byte reservations when an entity fails", async () => {
    const pool = createConnectorAssetBytePool(100, 2)

    await expect(
      withConnectorAssetBytePoolRollback(pool, async () => {
        expect(consumeConnectorAssetBytePool(pool, 60)).toBe(true)
        throw new Error("provider failed")
      }),
    ).rejects.toThrow("provider failed")

    expect(pool).toMatchObject({
      remainingBytes: 100,
      remainingAssets: 2,
    })
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
