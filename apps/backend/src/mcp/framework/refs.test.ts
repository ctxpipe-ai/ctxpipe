import { describe, expect, it } from "vitest"
import { formatRef, parseRef } from "./refs.js"
import { RepositoryHandles } from "./repository-handles.js"

const handles = RepositoryHandles.from([
  "https://github.com/example/payments-api",
  "https://github.com/example/api",
  "https://gitlab.example.com/example/api",
])

describe("parseRef", () => {
  it("reads a path as a knowledge unit ref", () => {
    expect(parseRef("knowledge/services/payments-api.md", handles)).toEqual({
      kind: "unit",
      path: "knowledge/services/payments-api.md",
    })
  })

  it("reads handle:path as a repository file ref", () => {
    expect(parseRef("example/payments-api:src/limits.ts", handles)).toEqual({
      kind: "file",
      handle: "example/payments-api",
      url: "https://github.com/example/payments-api",
      path: "src/limits.ts",
    })
  })

  it("reads a host/owner/name handle on a collision", () => {
    expect(
      parseRef("gitlab.example.com/example/api:README.md", handles),
    ).toMatchObject({ kind: "file", handle: "gitlab.example.com/example/api" })
  })

  it("reads the host/owner/name form of a short handle as that repository", () => {
    expect(
      parseRef("github.com/example/payments-api:src/limits.ts", handles),
    ).toMatchObject({
      kind: "file",
      handle: "example/payments-api",
      path: "src/limits.ts",
    })
  })

  it("matches a handle in another letter case", () => {
    expect(
      parseRef("Example/Payments-API:src/limits.ts", handles),
    ).toMatchObject({ kind: "file", handle: "example/payments-api" })
  })

  it("refuses a short handle that names two repositories", () => {
    expect(() => parseRef("example/api:README.md", handles)).toThrowError(
      expect.objectContaining({ code: "ambiguous_repository" }),
    )
  })

  it("matches the longest handle prefix first", () => {
    const nested = RepositoryHandles.from([
      "https://gitlab.example.com/group/app",
      "https://gitlab.example.com/group/app/sub",
    ])
    expect(parseRef("group/app/sub:README.md", nested)).toMatchObject({
      kind: "file",
      handle: "group/app/sub",
      path: "README.md",
    })
    expect(parseRef("group/app:sub:x.md", nested)).toMatchObject({
      kind: "file",
      handle: "group/app",
      path: "sub:x.md",
    })
  })

  it("reads a colon in a unit path as part of the path when the prefix is not a handle", () => {
    expect(parseRef("slack/threads/c1:1728.md", handles)).toEqual({
      kind: "unit",
      path: "slack/threads/c1:1728.md",
    })
  })

  it("keeps a colon in the file path after the handle", () => {
    expect(parseRef("example/payments-api:docs/a:b.md", handles)).toMatchObject(
      { kind: "file", path: "docs/a:b.md" },
    )
  })

  it("reads a prefix as a repository only when the Workspace links it", () => {
    const linked = new Set(["example/api"])
    expect(
      parseRef("example/payments-api:src/limits.ts", handles, linked),
    ).toEqual({ kind: "unit", path: "example/payments-api:src/limits.ts" })
    expect(
      parseRef("gitlab.example.com/example/api:README.md", handles, new Set()),
    ).toMatchObject({ kind: "unit" })
    expect(
      parseRef(
        "example/payments-api:src/limits.ts",
        handles,
        new Set(["example/payments-api"]),
      ),
    ).toMatchObject({ kind: "file", handle: "example/payments-api" })
  })

  it.each([
    "example/payments-api:.git/config",
    "example/payments-api:src/.GIT/hooks/x",
  ])("refuses a .git segment in the file ref %j", (ref) => {
    expect(() => parseRef(ref, handles)).toThrowError(
      expect.objectContaining({ code: "invalid_ref" }),
    )
  })

  it("keeps a .git segment in a unit path", () => {
    expect(parseRef("notes/.git/readme.md", handles)).toMatchObject({
      kind: "unit",
    })
  })

  it.each([
    "",
    "   ",
    "/etc/passwd",
    "knowledge/../secrets.md",
    "example/payments-api:",
    "example/payments-api:/abs.ts",
    "example/payments-api:src/../../x.ts",
    "a\0b.md",
  ])("refuses %j with invalid_ref", (ref) => {
    expect(() => parseRef(ref, handles)).toThrowError(
      expect.objectContaining({ code: "invalid_ref" }),
    )
  })
})

describe("formatRef", () => {
  it("round-trips both ref forms", () => {
    for (const ref of [
      "knowledge/services/payments-api.md",
      "example/payments-api:src/limits.ts",
    ]) {
      expect(formatRef(parseRef(ref, handles))).toBe(ref)
    }
  })
})
