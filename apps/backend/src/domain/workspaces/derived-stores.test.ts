import { describe, expect, it, vi } from "vitest"
import {
  codesearchSelectsWorkspaceCheckout,
  embedHydrateUnits,
  staleWorkspaceGraphDeleteCypher,
  workspaceCheckoutKey,
  workspaceGraphProjectionScope,
} from "./derived-stores.js"

describe("embedHydrateUnits", () => {
  it("does not swallow embedder failures so hydrate can retry the phase", async () => {
    await expect(
      embedHydrateUnits({
        units: [
          {
            path: "knowledge/a.md",
            servingId: "kn_a",
            body: "Hello",
            links: [],
            claims: [],
          },
        ],
        embed: async () => {
          throw new Error("upstream down")
        },
      }),
    ).rejects.toThrow("upstream down")
  })

  it("pairs vectors to serving ids", async () => {
    const embed = vi.fn().mockResolvedValue([[0.1, 0.2]])
    await expect(
      embedHydrateUnits({
        units: [
          {
            path: "knowledge/a.md",
            servingId: "kn_a",
            body: "Hello",
            links: [],
            claims: [],
          },
        ],
        embed,
      }),
    ).resolves.toEqual([{ servingId: "kn_a", embedding: [0.1, 0.2] }])
  })
})

describe("workspace derived-store scope", () => {
  it("scopes graph delete and codesearch checkout to the Workspace SHA", () => {
    expect(
      workspaceGraphProjectionScope({
        workspaceId: "ws_1",
        projectionSha: "abc",
      }),
    ).toEqual({ workspaceId: "ws_1", projectionSha: "abc" })
    expect(staleWorkspaceGraphDeleteCypher()).toContain("workspaceId")
    expect(staleWorkspaceGraphDeleteCypher()).toContain("projectionSha")
    expect(workspaceCheckoutKey("ws_1")).toBe("ws:ws_1")
    expect(
      codesearchSelectsWorkspaceCheckout({
        checkoutKey: "ws:ws_1",
        workspaceId: "ws_1",
      }),
    ).toBe(true)
    expect(
      codesearchSelectsWorkspaceCheckout({
        checkoutKey: "default",
        workspaceId: "ws_1",
      }),
    ).toBe(false)
  })
})
