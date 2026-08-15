import { describe, expect, it } from "vitest"
import {
  displayNameFromGitUrl,
  isValidSlug,
  nextSlugCandidate,
  normalizeSlug,
  normalizeWorkspaceRepositoryUrl,
  slugFromGitUrl,
} from "./slug.js"

describe("normalizeSlug", () => {
  it("lowercases and hyphenates", () => {
    expect(normalizeSlug("Ctx Pipe")).toBe("ctx-pipe")
  })

  it("falls back when empty", () => {
    expect(normalizeSlug("***")).toBe("workspace")
  })
})

describe("isValidSlug", () => {
  it("accepts hyphenated lowercase", () => {
    expect(isValidSlug("ctx-pipe")).toBe(true)
  })

  it("rejects uppercase and underscores", () => {
    expect(isValidSlug("CtxPipe")).toBe(false)
    expect(isValidSlug("ctx_pipe")).toBe(false)
  })
})

describe("slugFromGitUrl", () => {
  it("uses the GitHub repository name", () => {
    expect(slugFromGitUrl("https://github.com/acme/knowledge.git")).toBe(
      "knowledge",
    )
  })

  it("uses the last path segment for other git URLs", () => {
    expect(
      slugFromGitUrl("https://gitlab.example.com/group/sub/docs.git"),
    ).toBe("docs")
  })

  it("parses SSH GitHub URLs", () => {
    expect(slugFromGitUrl("git@github.com:acme/knowledge.git")).toBe(
      "knowledge",
    )
  })
})

describe("displayNameFromGitUrl", () => {
  it("keeps the original repo name casing", () => {
    expect(displayNameFromGitUrl("https://github.com/acme/Knowledge.git")).toBe(
      "Knowledge",
    )
  })
})

describe("nextSlugCandidate", () => {
  it("returns the base when free", () => {
    expect(nextSlugCandidate("knowledge", new Set())).toBe("knowledge")
  })

  it("suffixes -2, -3 on collision", () => {
    expect(nextSlugCandidate("knowledge", new Set(["knowledge"]))).toBe(
      "knowledge-2",
    )
    expect(
      nextSlugCandidate("knowledge", new Set(["knowledge", "knowledge-2"])),
    ).toBe("knowledge-3")
  })
})

describe("normalizeWorkspaceRepositoryUrl", () => {
  it("strips .git and trailing slash", () => {
    expect(
      normalizeWorkspaceRepositoryUrl("https://github.com/acme/knowledge.git/"),
    ).toBe("https://github.com/acme/knowledge")
  })

  it("canonicalises GitHub SSH to https", () => {
    expect(
      normalizeWorkspaceRepositoryUrl("git@github.com:acme/knowledge.git"),
    ).toBe("https://github.com/acme/knowledge")
  })
})
