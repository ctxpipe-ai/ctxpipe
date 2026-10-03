import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import {
  type OrgGate,
  orgGateKeys,
  orgGateOptions,
  peekOrgGate,
} from "./org-gate"

const memberGate: OrgGate = {
  session: {
    session: { id: "sess_1", userId: "user_1" },
    user: {
      id: "user_1",
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    },
  },
  organizations: [{ id: "org_1", name: "Acme", slug: "acme" }],
  orgAccessDenied: false,
}

describe("peekOrgGate", () => {
  it("returns cached gate for the org slug", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(orgGateOptions("acme").queryKey, memberGate)
    expect(peekOrgGate(queryClient, "acme")).toEqual(memberGate)
  })

  it("misses a different org slug", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(orgGateOptions("acme").queryKey, memberGate)
    expect(peekOrgGate(queryClient, "other")).toBeUndefined()
  })

  it("misses after the gate is invalidated", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(orgGateOptions("acme").queryKey, memberGate)
    await queryClient.invalidateQueries({ queryKey: orgGateKeys.all })
    expect(peekOrgGate(queryClient, "acme")).toBeUndefined()
  })
})
