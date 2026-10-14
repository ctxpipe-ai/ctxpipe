import { describe, expect, it } from "vitest"
import {
  githubPins,
  parseSourceState,
  reconcileGithubState,
} from "./workspace-source-state.js"

const pin = {
  id: "wlr_web",
  gitUrl: "https://github.com/acme/web",
  ref: null,
  desiredSha: "a".repeat(40),
  indexedSha: "a".repeat(40),
  createdAt: "2026-10-01T00:00:00.000Z",
}

describe("parseSourceState", () => {
  it("reads a GitHub state of a GitHub row", () => {
    expect(
      githubPins({
        id: "wsrc_1",
        provider: "github",
        state: { provider: "github", repositories: [pin] },
      }),
    ).toEqual([pin])
  })

  it("treats an empty, invalid, or foreign state as empty and does not throw", () => {
    for (const state of [
      {},
      null,
      [],
      "text",
      { provider: "github", repositories: "acme/web" },
      { provider: "github", repositories: [{ ...pin, id: "lnk_1" }] },
      { provider: "linear", cursor: "x" },
    ]) {
      expect(
        parseSourceState({ id: "wsrc_1", provider: "github", state }),
      ).toBe(null)
      expect(githubPins({ id: "wsrc_1", provider: "github", state })).toEqual(
        [],
      )
    }
    // A GitHub state on a row of another provider is not used.
    expect(
      githubPins({
        id: "wsrc_2",
        provider: "linear",
        state: { provider: "github", repositories: [pin] },
      }),
    ).toEqual([])
  })
})

describe("reconcileGithubState", () => {
  it("keeps the id and SHAs of an unchanged repository, renews a changed ref, and drops a removed one", () => {
    const api = { ...pin, id: "wlr_api", gitUrl: "https://github.com/acme/api" }
    const gone = {
      ...pin,
      id: "wlr_gone",
      gitUrl: "https://github.com/acme/gone",
    }
    const now = new Date("2026-10-15T00:00:00.000Z")
    const next = reconcileGithubState(
      [pin, api, gone],
      [
        { gitUrl: pin.gitUrl, ref: null },
        { gitUrl: api.gitUrl, ref: "release" },
        { gitUrl: "https://github.com/acme/new", ref: null },
      ],
      now,
    )
    expect(next.provider).toBe("github")
    expect(next.repositories[0]).toEqual(pin)
    expect(next.repositories[1]).toMatchObject({
      gitUrl: api.gitUrl,
      ref: "release",
      desiredSha: null,
      indexedSha: null,
      createdAt: now.toISOString(),
    })
    expect(next.repositories[1]?.id).not.toBe("wlr_api")
    expect(next.repositories[1]?.id.startsWith("wlr_")).toBe(true)
    expect(next.repositories[2]).toMatchObject({
      gitUrl: "https://github.com/acme/new",
      ref: null,
      desiredSha: null,
    })
    expect(next.repositories).toHaveLength(3)
  })
})
