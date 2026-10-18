import { describe, expect, it } from "vitest"
import {
  githubFetchCredentialRules,
  sandboxFetchUrl,
} from "./sandbox-credential-rules.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

/** The two paths that `git clone <url>` requests over smart HTTP. */
function fetchPaths(url: string): string[] {
  const base = new URL(url).pathname.replace(/\/$/, "")
  return [`${base}/info/refs`, `${base}/git-upload-pack`]
}

describe("sandboxFetchUrl", () => {
  it("gives a GitHub repository the URL whose fetch paths the egress rules allow", () => {
    // A shard spec holds the normalized Workspace URL, with no `.git`.
    const url = normalizeWorkspaceRepositoryUrl(
      "https://github.com/Acme/Checkout-API.git",
    )
    const allowed = githubFetchCredentialRules("token", [
      "acme/checkout-api",
    ]).map((rule) => rule.path)
    expect(allowed).not.toEqual(expect.arrayContaining(fetchPaths(url)))

    for (const repo of [
      { url },
      { url, kind: "github" },
      { url: "https://github.com/acme/checkout-api/" },
    ]) {
      const fetchUrl = sandboxFetchUrl(repo)
      expect(fetchUrl).toBe("https://github.com/acme/checkout-api.git")
      expect(allowed).toEqual(expect.arrayContaining(fetchPaths(fetchUrl)))
    }
  })

  it("keeps the URL of a plain git source", () => {
    expect(
      sandboxFetchUrl({
        kind: "git",
        url: "https://git.example.org/team/project.git",
      }),
    ).toBe("https://git.example.org/team/project.git")
  })

  it("refuses a destination that is not on GitHub", () => {
    expect(() =>
      sandboxFetchUrl({ url: "https://git.example.org/team/project" }),
    ).toThrow("Ingest repositories must be on GitHub")
  })
})
