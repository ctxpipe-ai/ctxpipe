import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fetchMock = vi.fn<typeof fetch>()

function requestAt(index: number): Request {
  const call = fetchMock.mock.calls[index]
  if (!call) throw new Error(`Missing fetch call ${index}`)
  return new Request(call[0], call[1])
}

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

describe("API-key client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock)
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it("lists only the requested organisation key configuration", async () => {
    const { listOrganizationApiKeys } = await import("./organizationApiKeys")
    fetchMock.mockResolvedValue(
      jsonResponse({ apiKeys: [{ id: "key_org", name: "ci" }], total: 1 }),
    )

    await expect(listOrganizationApiKeys("org_acme")).resolves.toEqual([
      { id: "key_org", name: "ci" },
    ])
    const request = requestAt(0)
    expect(request.method).toBe("GET")
    expect(new URL(request.url).searchParams).toEqual(
      new URLSearchParams({
        configId: "organization",
        organizationId: "org_acme",
      }),
    )
  })

  it("creates organisation-owned keys and explicitly clears a never expiry", async () => {
    const { createOrganizationApiKey } = await import("./organizationApiKeys")
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "key_org", key: "secret" }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))

    await createOrganizationApiKey({
      organizationId: "org_acme",
      name: "coderabbit",
      expiresIn: null,
    })

    expect(await requestAt(0).json()).toEqual({
      configId: "organization",
      organizationId: "org_acme",
      name: "coderabbit",
    })
    expect(await requestAt(1).json()).toEqual({
      keyId: "key_org",
      configId: "organization",
      expiresIn: null,
    })
  })

  it("revokes only through the organisation key configuration", async () => {
    const { deleteOrganizationApiKey } = await import("./organizationApiKeys")
    fetchMock.mockResolvedValue(jsonResponse({ success: true }))

    await deleteOrganizationApiKey("key_org")

    expect(await requestAt(0).json()).toEqual({
      keyId: "key_org",
      configId: "organization",
    })
  })

  it("uses the personal key configuration without an organisation id", async () => {
    const { createPersonalApiKey, deletePersonalApiKey, listPersonalApiKeys } =
      await import("./organizationApiKeys")
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ apiKeys: [], total: 0 }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "key_personal", key: "secret" }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }))

    await listPersonalApiKeys()
    await createPersonalApiKey({
      name: "my-agent",
      expiresIn: 30 * 24 * 60 * 60,
    })
    await deletePersonalApiKey("key_personal")

    expect(new URL(requestAt(0).url).searchParams).toEqual(
      new URLSearchParams({ configId: "default" }),
    )
    expect(await requestAt(1).json()).toEqual({
      configId: "default",
      name: "my-agent",
      expiresIn: 2_592_000,
    })
    expect(await requestAt(2).json()).toEqual({
      keyId: "key_personal",
      configId: "default",
    })
  })
})
