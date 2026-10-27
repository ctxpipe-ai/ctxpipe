import { initLogger } from "evlog"
import { describe, expect, it } from "vitest"

import {
  githubPins,
  lastGoodTarget,
  parseSourceState,
  planSourceStates,
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

describe("lastGoodTarget", () => {
  const target = {
    provider: "linear",
    connectionId: "con_linear1",
    scope: { teams: ["ENG"] },
  }
  const row = (status: string, state: unknown) => ({
    id: "wsrc_1",
    provider: "linear",
    connectionId: "con_linear1",
    scope: { teams: ["OPS"] },
    status,
    state,
  })

  it("gives the columns of a valid row", () => {
    expect(lastGoodTarget(row("ok", {}))).toEqual({
      ...target,
      scope: { teams: ["OPS"] },
    })
    expect(
      lastGoodTarget({ ...row("ok", {}), provider: null, connectionId: null }),
    ).toBe(null)
  })

  it("gives the kept target of an invalid row, or null", () => {
    expect(lastGoodTarget(row("invalid", { lastGoodTarget: target }))).toEqual(
      target,
    )
    expect(lastGoodTarget(row("invalid", {}))).toBe(null)
    expect(
      lastGoodTarget(row("invalid", { lastGoodTarget: { provider: 5 } })),
    ).toBe(null)
  })

  it("keeps the GitHub pins of a state that also has a target", () => {
    expect(
      githubPins({
        id: "wsrc_1",
        provider: "github",
        state: {
          provider: "github",
          repositories: [pin],
          lastGoodTarget: target,
        },
      }),
    ).toEqual([pin])
    expect(
      parseSourceState({
        id: "wsrc_1",
        provider: "linear",
        state: { lastGoodTarget: target },
      }),
    ).toBe(null)
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

describe("planSourceStates", () => {
  const github = (
    sourceKey: string,
    repositories: string[],
    status: "ok" | "out_of_access" | "invalid" | "connection_missing" = "ok",
  ) => ({
    sourceKey,
    provider: "github" as const,
    status,
    scope: { repositories },
  })
  const row = (sourceKey: string, pins: (typeof pin)[]) => ({
    id: `wsrc_${sourceKey}`,
    sourceKey,
    provider: "github",
    connectionId: "con_github1",
    scope: {},
    status: "ok",
    state: { provider: "github", repositories: pins },
  })
  const api = {
    ...pin,
    id: "wlr_api",
    gitUrl: "https://github.com/acme/api",
  }

  it("keeps the pins of a row whose connection is missing, and gives them back on recovery", () => {
    const broken = planSourceStates({
      existing: [row("code", [pin])],
      planned: [github("code", ["acme/web"], "connection_missing")],
      workspaceUrl: null,
    })
    expect(broken.get("code")).toEqual({
      provider: "github",
      repositories: [pin],
    })
    const recovered = planSourceStates({
      existing: [row("code", [pin])],
      planned: [github("code", ["acme/web"])],
      workspaceUrl: null,
    })
    expect(recovered.get("code")).toEqual({
      provider: "github",
      repositories: [pin],
    })
  })

  it("keeps the id and SHAs of a repository that moves to another entry", () => {
    const states = planSourceStates({
      existing: [row("a", [pin, api]), row("b", [])],
      planned: [github("a", ["acme/api"]), github("b", ["acme/web"])],
      workspaceUrl: null,
    })
    expect(states.get("a")).toEqual({ provider: "github", repositories: [api] })
    expect(states.get("b")).toEqual({ provider: "github", repositories: [pin] })
  })

  it("moves a pin out of a broken row when a usable row links the repository", () => {
    const states = planSourceStates({
      existing: [row("old", [pin])],
      planned: [
        github("old", ["acme/web"], "invalid"),
        github("new", ["acme/web"]),
      ],
      workspaceUrl: "https://github.com/acme/knowledge",
    })
    expect(states.get("new")).toEqual({
      provider: "github",
      repositories: [pin],
    })
    // The broken row keeps the target of its last valid entry.
    expect(states.get("old")).toEqual({
      provider: "github",
      repositories: [],
      lastGoodTarget: {
        provider: "github",
        connectionId: "con_github1",
        scope: {},
      },
    })
  })

  it("gives a non-GitHub row an empty state and skips the Workspace repository", () => {
    const states = planSourceStates({
      existing: [],
      planned: [
        {
          sourceKey: "issues",
          provider: "linear",
          status: "ok",
          scope: { teams: ["ENG"] },
        },
        github("code", ["acme/knowledge"]),
      ],
      workspaceUrl: "https://github.com/acme/knowledge",
    })
    expect(states.get("issues")).toEqual({})
    expect(states.get("code")).toEqual({ provider: "github", repositories: [] })
  })
})

describe("planSourceStates for source files", () => {
  const file = (sourceKey: string, repository: string, ref?: string) => ({
    sourceKey,
    provider: "github" as const,
    status: "ok",
    scope: ref ? { repository, ref } : { repository },
  })
  const main = { ...pin, id: "wlr_main", ref: "main" }
  const release = {
    ...pin,
    id: "wlr_release",
    ref: "release",
    desiredSha: "b".repeat(40),
    indexedSha: "b".repeat(40),
  }

  it("gives a renamed file the pin of its repository and ref", () => {
    const states = planSourceStates({
      existing: [
        {
          id: "wsrc_old",
          sourceKey: "sources/github/acme/web.md",
          provider: "github",
          connectionId: null,
          scope: {},
          status: "ok",
          state: { provider: "github", repositories: [pin] },
        },
      ],
      planned: [file("sources/github/acme/frontend.md", "acme/web")],
      workspaceUrl: null,
    })
    expect(states.get("sources/github/acme/frontend.md")).toEqual({
      provider: "github",
      repositories: [pin],
    })
  })

  it("matches a pin by repository and ref, not by the first pin of the repository", () => {
    const states = planSourceStates({
      existing: [
        {
          id: "wsrc_b",
          sourceKey: "sources/github/acme/web.md",
          provider: "github",
          connectionId: null,
          scope: {},
          status: "ok",
          state: { provider: "github", repositories: [release] },
        },
        {
          id: "wsrc_a",
          sourceKey: "sources/github/acme/web-main.md",
          provider: "github",
          connectionId: null,
          scope: {},
          status: "ok",
          state: { provider: "github", repositories: [main] },
        },
      ],
      planned: [
        file("sources/github/acme/web-main.md", "acme/web", "main"),
        {
          ...file("sources/github/acme/web.md", "acme/web", "release"),
          status: "invalid",
        },
        file("sources/github/acme/web-release.md", "acme/web", "release"),
      ],
      workspaceUrl: null,
    })
    expect(states.get("sources/github/acme/web-main.md")).toEqual({
      provider: "github",
      repositories: [main],
    })
  })

  it("keeps the pin of a renamed file that is invalid at that revision", () => {
    const existing = [
      {
        id: "wsrc_old",
        sourceKey: "sources/github/acme/web.md",
        provider: "github",
        connectionId: null,
        scope: {},
        status: "ok",
        state: { provider: "github", repositories: [main] },
      },
    ]
    const renamed = {
      ...file("sources/github/acme/frontend.md", "acme/web", "main"),
      status: "invalid",
    }
    const invalid = planSourceStates({
      existing,
      planned: [renamed],
      workspaceUrl: null,
    })
    expect(invalid.get("sources/github/acme/frontend.md")).toEqual({
      provider: "github",
      repositories: [main],
    })
    const fixed = planSourceStates({
      existing: [
        {
          id: "wsrc_new",
          sourceKey: "sources/github/acme/frontend.md",
          provider: "github",
          connectionId: null,
          scope: {},
          status: "ok",
          state: invalid.get("sources/github/acme/frontend.md"),
        },
      ],
      planned: [file("sources/github/acme/frontend.md", "acme/web", "main")],
      workspaceUrl: null,
    })
    expect(fixed.get("sources/github/acme/frontend.md")).toEqual({
      provider: "github",
      repositories: [main],
    })
  })

  it("gives the pin of a repository to the source file, not to a YAML entry that also names it", () => {
    const states = planSourceStates({
      existing: [],
      planned: [
        {
          sourceKey: "apps",
          provider: "github",
          status: "ok",
          scope: { repositories: ["acme/web", "acme/api"] },
        },
        file("sources/github/acme/web.md", "acme/web"),
      ],
      workspaceUrl: null,
    })
    const urls = (key: string) =>
      (
        states.get(key) as { repositories: Array<{ gitUrl: string }> }
      ).repositories.map((pin) => pin.gitUrl)
    expect(urls("sources/github/acme/web.md")).toEqual([
      "https://github.com/acme/web",
    ])
    expect(urls("apps")).toEqual(["https://github.com/acme/api"])
  })

  it("gives a new id and no SHAs when the ref changes", () => {
    const states = planSourceStates({
      existing: [
        {
          id: "wsrc_a",
          sourceKey: "sources/github/acme/web.md",
          provider: "github",
          connectionId: null,
          scope: {},
          status: "ok",
          state: { provider: "github", repositories: [main] },
        },
      ],
      planned: [file("sources/github/acme/web.md", "acme/web", "release")],
      workspaceUrl: null,
    })
    const [next] = (
      states.get("sources/github/acme/web.md") as {
        repositories: (typeof pin)[]
      }
    ).repositories
    expect(next).toMatchObject({
      ref: "release",
      desiredSha: null,
      indexedSha: null,
    })
    expect(next?.id).not.toBe("wlr_main")
  })
})

describe("an invalid row whose stored target does not parse", () => {
  it("logs once when the projection writes it, not on each read, and keeps it", () => {
    const events: unknown[] = []
    initLogger({
      silent: true,
      drain: (ctx) => {
        events.push(ctx.event)
      },
    })
    const warn = () =>
      events.filter((event) =>
        JSON.stringify(event).includes("workspace_sources.state_invalid"),
      )
    const target = { provider: "linear", connectionId: "", scope: 1 }
    const row = {
      id: "wsrc_held",
      sourceKey: "issues",
      provider: "linear",
      connectionId: "con_linear",
      scope: {},
      status: "invalid",
      state: { lastGoodTarget: target },
    }
    expect(lastGoodTarget(row)).toBeNull()
    expect(lastGoodTarget(row)).toBeNull()
    expect(warn()).toHaveLength(0)

    const states = planSourceStates({
      existing: [row],
      planned: [
        {
          sourceKey: "issues",
          provider: "linear",
          status: "invalid",
          scope: {},
        },
      ],
      workspaceUrl: null,
    })
    expect(states.get("issues")).toEqual({ lastGoodTarget: target })
    expect(warn()).toHaveLength(1)
  })
})
