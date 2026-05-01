import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  fetchForgeProvisionStatus,
  postForgeProvision,
} from "./atlassian-connector"

describe("Forge provision API helpers", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch)
  })

  it("POST provision sends JSON body with 202 Accepted", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ accepted: true, workflowName: "forge-provision" }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    )
    const body = {
      connectionId: "c1",
      confluenceSiteHost: "acme.atlassian.net",
      forgeScopedApiToken: "tok",
      forgeOperatorEmail: "atl@example.com",
    }
    const json = await postForgeProvision("org", body)
    expect(json.accepted).toBe(true)
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/org/api/v1/connectors/atlassian/provision",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify(body),
      }),
    )
  })

  it("GET provision-status parses JSON", async () => {
    const payload = {
      connectionId: "c1",
      provisionStatus: "running" as const,
      provisionErrorCode: null as null,
      userMessage: null as null,
    }
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    const json = await fetchForgeProvisionStatus("org", "c1")
    expect(json).toEqual(payload)
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/org/api/v1/connectors/atlassian/provision-status?connectionId=c1",
      expect.objectContaining({ credentials: "include" }),
    )
  })
})
