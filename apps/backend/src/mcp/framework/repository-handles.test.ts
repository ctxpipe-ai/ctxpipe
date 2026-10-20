import { describe, expect, it } from "vitest"
import { RepositoryHandles } from "./repository-handles.js"
import { McpToolError } from "./tool-errors.js"

describe("RepositoryHandles", () => {
  it("gives owner/name for each linked repository", () => {
    const handles = RepositoryHandles.from([
      "https://github.com/Example/Payments-API.git",
      "git@gitlab.example.com:platform/libs.git",
    ])
    expect(handles.list().map((repository) => repository.handle)).toEqual([
      "example/payments-api",
      "platform/libs",
    ])
  })

  it("drops the port from the handle and the key", () => {
    const handles = RepositoryHandles.from([
      "https://git.example.com:8443/team/api.git",
      "ssh://git@git.example.com:2222/team/api.git",
    ])
    expect(handles.list()).toEqual([
      { handle: "team/api", url: expect.any(String) },
    ])
  })

  it("gives host/owner/name to both repositories when owner/name collides on two hosts", () => {
    const handles = RepositoryHandles.from([
      "https://github.com/example/api",
      "https://gitlab.example.com/example/api",
      "https://github.com/example/web",
    ])
    expect(handles.list().map((repository) => repository.handle)).toEqual([
      "github.com/example/api",
      "gitlab.example.com/example/api",
      "example/web",
    ])
  })

  it("keeps subgroup paths in the handle", () => {
    const handles = RepositoryHandles.from([
      "https://gitlab.example.com/group/sub/name.git",
    ])
    expect(handles.list()[0]?.handle).toBe("group/sub/name")
  })

  it("counts the same repository in two URL forms as one repository", () => {
    const handles = RepositoryHandles.from([
      "https://github.com/example/api",
      "git@github.com:example/api.git",
    ])
    expect(handles.list()).toHaveLength(1)
  })

  it.each([
    "example/payments-api",
    "Example/Payments-API",
    "github.com/example/payments-api",
    "https://github.com/example/payments-api",
    "https://github.com/example/payments-api.git",
    "https://github.com/Example/Payments-API/",
    "git@github.com:example/payments-api.git",
    "git@github.com:example/payments-api",
    "ssh://git@github.com/example/payments-api.git",
    "ssh://git@github.com:2222/example/payments-api.git",
    "deploy@github.com:example/payments-api.git",
    "github.com:example/payments-api.git",
  ])("resolves %s to the same repository", (input) => {
    const handles = RepositoryHandles.from([
      "https://github.com/example/payments-api",
      "https://github.com/example/other",
    ])
    expect(handles.resolve(input).handle).toBe("example/payments-api")
  })

  it("refuses an unknown repository with repository_not_found", () => {
    const handles = RepositoryHandles.from(["https://github.com/example/api"])
    expect(() => handles.resolve("example/unknown")).toThrowError(
      expect.objectContaining({ code: "repository_not_found" }),
    )
  })

  it("refuses a short handle that matches two hosts with ambiguous_repository", () => {
    const handles = RepositoryHandles.from([
      "https://github.com/example/api",
      "https://gitlab.example.com/example/api",
    ])
    let error: unknown
    try {
      handles.resolve("example/api")
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(McpToolError)
    expect(error).toMatchObject({ code: "ambiguous_repository" })
    expect(handles.resolve("gitlab.example.com/example/api").handle).toBe(
      "gitlab.example.com/example/api",
    )
  })
})

describe("RepositoryHandles.exclusion", () => {
  const handles = RepositoryHandles.from([
    "https://github.com/example/payments-api",
    "https://github.com/example/ledger",
    "https://gitlab.example.com/example/ledger",
  ])

  it.each([
    ["handle", "example/payments-api"],
    ["HTTPS", "https://github.com/example/payments-api"],
    ["HTTPS with .git", "https://github.com/example/payments-api.git"],
    ["SSH", "git@github.com:example/payments-api.git"],
  ])("excludes by %s", (_form, input) => {
    const exclusion = handles.exclusion([input])
    expect(exclusion.excluded).toEqual(["example/payments-api"])
    expect(
      exclusion.isExcluded("https://github.com/example/payments-api"),
    ).toBe(true)
    expect(exclusion.isExcluded("https://github.com/example/ledger")).toBe(
      false,
    )
  })

  it.each([
    [
      "SCP form with another user",
      "deploy@github.com:example/payments-api.git",
    ],
    ["SCP form with no user", "github.com:example/payments-api"],
    [
      "ssh:// with a port",
      "ssh://git@github.com:2222/example/payments-api.git",
    ],
    ["HTTPS with a port", "https://github.com:443/example/payments-api"],
  ])("excludes by the %s", (_form, input) => {
    expect(handles.exclusion([input]).excluded).toEqual([
      "example/payments-api",
    ])
  })

  it.each([
    "example/not-linked",
    "not a repository",
    "",
  ])("refuses the entry %j that names no repository with invalid_argument", (input) => {
    expect(() => handles.exclusion([input])).toThrowError(
      expect.objectContaining({ code: "invalid_argument" }),
    )
  })

  it("excludes every host for a short handle that collides", () => {
    const exclusion = handles.exclusion(["example/ledger"])
    expect(exclusion.excluded).toEqual([
      "github.com/example/ledger",
      "gitlab.example.com/example/ledger",
    ])
  })

  it("excludes a repository that is not linked, by URL", () => {
    const exclusion = handles.exclusion(["git@github.com:example/local.git"])
    expect(exclusion.excluded).toEqual([])
    expect(exclusion.isExcluded("https://github.com/example/local.git")).toBe(
      true,
    )
  })

  it("excludes nothing for an empty list", () => {
    const exclusion = handles.exclusion([])
    expect(exclusion.excluded).toEqual([])
    expect(exclusion.isExcluded("https://github.com/example/ledger")).toBe(
      false,
    )
  })
})
