import { beforeEach, describe, expect, it, vi } from "vitest"

const getContextMock = vi.hoisted(() => vi.fn())

vi.mock("hono/context-storage", () => ({
  getContext: getContextMock,
}))

vi.mock("./withAuth.js", () => ({
  orgIdStorage: { getStore: () => undefined },
}))

import { currentMcpActor } from "./context.js"

describe("currentMcpActor", () => {
  beforeEach(() => {
    getContextMock.mockReset()
  })

  it("returns org-service when an org API key is set, even with no user", () => {
    getContextMock.mockReturnValue({
      var: {
        orgApiKey: {
          id: "key_1",
          orgId: "org_acme",
          configId: "organization",
        },
        user: null,
      },
    })
    expect(currentMcpActor()).toEqual({
      type: "org-service",
      orgId: "org_acme",
    })
  })

  it("returns user when a session user is set and no org API key", () => {
    getContextMock.mockReturnValue({
      var: {
        orgApiKey: null,
        user: { id: "user_1" },
      },
    })
    expect(currentMcpActor()).toEqual({ type: "user", userId: "user_1" })
  })

  it("throws when neither org API key nor user is present", () => {
    getContextMock.mockReturnValue({
      var: { orgApiKey: null, user: null },
    })
    expect(() => currentMcpActor()).toThrow("Missing MCP actor context")
  })
})
