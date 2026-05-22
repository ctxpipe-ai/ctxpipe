import { describe, expect, it } from "vitest"
import type { GitHubInstallationShape } from "./connection-rows.js"
import {
  githubConnectionIsLinked,
  resolveGithubInstallationFromList,
} from "./github-installation.js"

function row(
  partial: Partial<GitHubInstallationShape> & Pick<GitHubInstallationShape, "id">,
): GitHubInstallationShape {
  return {
    orgId: "org_1",
    installationId: null,
    accountSlug: null,
    ingestAllRepositories: false,
    includeFutureRepos: false,
    appSlug: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...partial,
  }
}

describe("resolveGithubInstallationFromList", () => {
  it("returns none for an empty list", () => {
    expect(resolveGithubInstallationFromList([])).toEqual({ status: "none" })
  })

  it("returns the single linked installation when a draft row also exists", () => {
    const linked = row({ id: "con_linked", installationId: 42 })
    const draft = row({ id: "con_draft" })
    const result = resolveGithubInstallationFromList([draft, linked])
    expect(result).toEqual({ status: "ok", installation: linked })
  })

  it("returns ambiguous when multiple linked installations exist", () => {
    const a = row({ id: "con_a", installationId: 1 })
    const b = row({ id: "con_b", installationId: 2 })
    expect(resolveGithubInstallationFromList([a, b])).toEqual({
      status: "ambiguous",
    })
  })

  it("returns the sole row when it is an unlinked draft", () => {
    const draft = row({ id: "con_draft" })
    expect(resolveGithubInstallationFromList([draft])).toEqual({
      status: "ok",
      installation: draft,
    })
  })

  it("returns ambiguous when multiple unlinked rows exist", () => {
    const a = row({ id: "con_a" })
    const b = row({ id: "con_b" })
    expect(resolveGithubInstallationFromList([a, b])).toEqual({
      status: "ambiguous",
    })
  })
})

describe("githubConnectionIsLinked", () => {
  it("is false without installationId", () => {
    expect(githubConnectionIsLinked(row({ id: "con_1" }))).toBe(false)
  })

  it("is true when installationId is set", () => {
    expect(
      githubConnectionIsLinked(row({ id: "con_1", installationId: 99 })),
    ).toBe(true)
  })
})
