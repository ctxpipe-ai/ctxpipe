import { describe, expect, it } from "vitest"
import {
  candidateFromPullRequestPayload,
  githubPrMirrorIdempotencyKey,
} from "./github-pr-mirror-events.js"

describe("GitHub pull-request webhook facts", () => {
  it("derives candidates from payload facts", () => {
    expect(
      candidateFromPullRequestPayload({
        number: 1,
        merged_at: "2026-03-02T11:00:00Z",
        draft: false,
        state: "closed",
        updated_at: "2026-03-02T11:00:00Z",
      }),
    ).toEqual({
      state: "closed",
      draft: false,
      updatedAt: "2026-03-02T11:00:00Z",
    })
    expect(
      candidateFromPullRequestPayload({
        number: 1,
        merged: false,
        merged_at: null,
        draft: false,
        state: "closed",
        updated_at: "t",
      }),
    ).toEqual({ state: "closed", draft: false, updatedAt: "t" })
    expect(
      candidateFromPullRequestPayload({
        number: 1,
        merged: false,
        draft: false,
        updated_at: "t",
      }),
    ).toBeUndefined()
    expect(
      candidateFromPullRequestPayload({ number: 1, updated_at: "t" }),
    ).toBeUndefined()
    expect(candidateFromPullRequestPayload(undefined)).toBeUndefined()
  })

  it("keys a delivery per Workspace, repository, pull request and version", () => {
    expect(
      githubPrMirrorIdempotencyKey({
        workspaceId: "ws_a",
        gitUrl: "https://github.com/a/b",
        number: 3,
        version: undefined,
      }),
    ).toBe("github-pr:ws_a:https://github.com/a/b:3:unknown")
  })
})
