import { describe, expect, it } from "vitest"
import type { WorkspaceRevision } from "./revision.js"
import {
  BASE_STALE_AGE_MS,
  BASE_STALE_COMMITS,
  baseRefOfIdentity,
  conversationImageIdentity,
  workspaceBaseIsStale,
} from "./workspace-sandbox-base.js"

const revision = (sha: string): WorkspaceRevision => ({
  workspaceId: "ws_test",
  remote: { url: "https://github.com/acme/context.git", connectionId: null },
  sha,
  generation: 1,
  defaultBranch: "main",
  access: "read",
})
const now = new Date("2026-10-04T12:00:00Z")
const builtAgo = (ms: number) => ({
  revision: revision("a".repeat(40)),
  createdAt: new Date(now.getTime() - ms),
})

describe("workspaceBaseIsStale", () => {
  it("keeps a base on the current commit, however old", () => {
    expect(
      workspaceBaseIsStale({
        base: builtAgo(10 * BASE_STALE_AGE_MS),
        desiredSha: "a".repeat(40),
        now,
        commitsBehind: 0,
      }),
    ).toBe(false)
  })

  it("rebuilds once the branch moved and the base is a day old", () => {
    const stale = (age: number) =>
      workspaceBaseIsStale({
        base: builtAgo(age),
        desiredSha: "b".repeat(40),
        now,
        commitsBehind: 1,
      })
    expect(stale(BASE_STALE_AGE_MS - 1)).toBe(false)
    expect(stale(BASE_STALE_AGE_MS)).toBe(true)
  })

  it(`rebuilds sooner once more than ${BASE_STALE_COMMITS} commits behind`, () => {
    const stale = (commitsBehind: number | null) =>
      workspaceBaseIsStale({
        base: builtAgo(60_000),
        desiredSha: "b".repeat(40),
        now,
        commitsBehind,
      })
    expect(stale(BASE_STALE_COMMITS)).toBe(false)
    expect(stale(BASE_STALE_COMMITS + 1)).toBe(true)
    // Unknown (not GitHub): only age counts.
    expect(stale(null)).toBe(false)
  })
})

describe("conversation image identity", () => {
  it("records the base a conversation started from", () => {
    const identity = conversationImageIdentity("sha256:agent", "sha256:base")
    expect(baseRefOfIdentity(identity)).toBe("sha256:base")
    expect(baseRefOfIdentity(conversationImageIdentity("sha256:agent"))).toBe(
      undefined,
    )
    expect(baseRefOfIdentity("vercel-node24/opencode-ai@1.18.34")).toBe(
      undefined,
    )
  })
})
