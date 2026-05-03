import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CTXPIPE_FORGE_AUTO_DEVELOPER_SPACE_NAME,
  ensureCtxpipeForgeDeveloperSpaceId,
} from "./forge-provision.js"

describe("ensureCtxpipeForgeDeveloperSpaceId", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch)
  })

  it("creates developer space when no matching listed space exists", async () => {
    const email = "alice@example.com"
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const hdrs = init?.headers as Record<string, string>
        expect(hdrs.authorization).toBe(
          `Basic ${Buffer.from(`${email}:tok`).toString("base64")}`,
        )
        const raw = JSON.parse(String(init?.body ?? "{}")) as { query: string }
        const q = raw.query
        if (q.includes("GetDevSpaceWithLinkingAccess")) {
          return new Response(
            JSON.stringify({
              data: {
                ecosystem: {
                  devConsole: {
                    getDeveloperSpaceWithLinkingAccess: ["sid-1"],
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (q.includes("GetDevSpaceDetails")) {
          return new Response(
            JSON.stringify({
              data: {
                ecosystem: {
                  devConsole: {
                    getDeveloperSpaceDetails: {
                      results: [
                        {
                          developerSpaceId: "sid-1",
                          details: { name: "Unrelated workspace" },
                        },
                      ],
                    },
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (q.includes("CreateDeveloperSpace")) {
          return new Response(
            JSON.stringify({
              data: {
                ecosystem: {
                  devConsole: {
                    createDeveloperSpace: {
                      devSpace: {
                        id: "created-new",
                        name: CTXPIPE_FORGE_AUTO_DEVELOPER_SPACE_NAME,
                      },
                      success: true,
                      errors: [],
                    },
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        return new Response("unexpected", { status: 500 })
      }),
    )

    await expect(
      ensureCtxpipeForgeDeveloperSpaceId({
        operatorEmail: email,
        apiToken: "tok",
      }),
    ).resolves.toBe("created-new")
  })

  it("returns existing id when listed space matches by name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const raw = JSON.parse(String(init?.body ?? "{}")) as { query: string }
        const q = raw.query
        if (q.includes("GetDevSpaceWithLinkingAccess")) {
          return new Response(
            JSON.stringify({
              data: {
                ecosystem: {
                  devConsole: {
                    getDeveloperSpaceWithLinkingAccess: ["prior"],
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (q.includes("GetDevSpaceDetails")) {
          return new Response(
            JSON.stringify({
              data: {
                ecosystem: {
                  devConsole: {
                    getDeveloperSpaceDetails: {
                      results: [
                        {
                          developerSpaceId: "prior",
                          details: {
                            name: CTXPIPE_FORGE_AUTO_DEVELOPER_SPACE_NAME,
                          },
                        },
                      ],
                    },
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        return new Response("unexpected", { status: 500 })
      }),
    )

    await expect(
      ensureCtxpipeForgeDeveloperSpaceId({
        operatorEmail: "alice@example.com",
        apiToken: "tok",
      }),
    ).resolves.toBe("prior")

    const fn = fetch as unknown as ReturnType<typeof vi.fn>
    const bodies = fn.mock.calls.map((c) => String(c[1]?.body ?? ""))
    expect(bodies.some((b) => b.includes("CreateDeveloperSpace"))).toBe(false)
  })
})
