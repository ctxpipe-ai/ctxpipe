import HyperDX from "@hyperdx/browser"
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
  let addAction: ReturnType<typeof vi.spyOn<typeof HyperDX, "addAction">>

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock)
    vi.resetModules()
    addAction = vi.spyOn(HyperDX, "addAction").mockImplementation(() => {})
  })

  afterEach(() => {
    addAction.mockRestore()
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it("lists only the requested organization key configuration", async () => {
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

  it("creates organization-owned keys and explicitly clears a never expiry", async () => {
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

  it("revokes only through the organization key configuration", async () => {
    const { deleteOrganizationApiKey } = await import("./organizationApiKeys")
    fetchMock.mockResolvedValue(jsonResponse({ success: true }))

    await deleteOrganizationApiKey("key_org")

    expect(await requestAt(0).json()).toEqual({
      keyId: "key_org",
      configId: "organization",
    })
  })

  it("uses the personal key configuration without an organization id, and sends the org set", async () => {
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
      organizationIds: ["org_a", "org_b"],
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
    // The backend writes this org set before it answers with the secret.
    expect(requestAt(1).headers.get("x-ctxpipe-api-key-organizations")).toBe(
      "org_a,org_b",
    )
    expect(await requestAt(2).json()).toEqual({
      keyId: "key_personal",
      configId: "default",
    })
  })

  describe("HyperDX actions", () => {
    it("records api_key_create with the key id, the owner and the org set size, and never the secret", async () => {
      const { createOrganizationApiKey, createPersonalApiKey } = await import(
        "./organizationApiKeys"
      )
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ id: "key_personal", key: "SECRET_PERSONAL" }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ id: "key_org", key: "SECRET_ORG" }),
        )

      await createPersonalApiKey({
        name: "my-agent",
        expiresIn: 2_592_000,
        organizationIds: ["org_a", "org_b"],
      })
      await createOrganizationApiKey({
        organizationId: "org_acme",
        name: "ci",
        expiresIn: 2_592_000,
      })

      expect(addAction.mock.calls).toEqual([
        [
          "api_key_create",
          { owner: "personal", key_id: "key_personal", organization_count: 2 },
        ],
        ["api_key_create", { owner: "organization", key_id: "key_org" }],
      ])
      expect(JSON.stringify(addAction.mock.calls)).not.toContain("SECRET")
    })

    it("records no api_key_create when the key is not created", async () => {
      const { createOrganizationApiKey } = await import("./organizationApiKeys")
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ message: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      )

      await expect(
        createOrganizationApiKey({
          organizationId: "org_acme",
          name: "ci",
          expiresIn: null,
        }),
      ).rejects.toBeDefined()

      expect(addAction).not.toHaveBeenCalled()
    })

    it("records api_key_revoke with the key id and the owner", async () => {
      const { deleteOrganizationApiKey, deletePersonalApiKey } = await import(
        "./organizationApiKeys"
      )
      fetchMock.mockImplementation(async () => jsonResponse({ success: true }))

      await deletePersonalApiKey("key_personal")
      await deleteOrganizationApiKey("key_org")

      expect(addAction.mock.calls).toEqual([
        ["api_key_revoke", { owner: "personal", key_id: "key_personal" }],
        ["api_key_revoke", { owner: "organization", key_id: "key_org" }],
      ])
    })

    it("records api_key_copy with the key id and the owner, and never the secret", async () => {
      const { recordApiKeyCopied } = await import("./organizationApiKeys")

      recordApiKeyCopied("personal", "key_personal")

      expect(addAction.mock.calls).toEqual([
        ["api_key_copy", { owner: "personal", key_id: "key_personal" }],
      ])
    })
  })
})
