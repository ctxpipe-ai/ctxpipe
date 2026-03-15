import { describe, expect, it } from "vitest"
import { buildSourceLink } from "./buildSourceLink.js"

describe("buildSourceLink", () => {
  it("uses sourceUrl when provided", () => {
    expect(
      buildSourceLink({
        orgSlug: "acme",
        sourceType: "confluence",
        sourceId: "page-123",
        sourceUrl: "https://acme.atlassian.net/wiki/page-123",
      }),
    ).toBe("https://acme.atlassian.net/wiki/page-123")
  })

  it("builds link from orgSlug, sourceType, sourceId when sourceUrl absent", () => {
    expect(
      buildSourceLink({
        orgSlug: "acme",
        sourceType: "git",
        sourceId: "repo/main/file.ts",
      }),
    ).toBe("/acme/sources/git/repo%2Fmain%2Ffile.ts")
  })

  it("ignores empty sourceUrl", () => {
    expect(
      buildSourceLink({
        orgSlug: "acme",
        sourceType: "manual",
        sourceId: "doc-1",
        sourceUrl: "",
      }),
    ).toBe("/acme/sources/manual/doc-1")
  })
})
