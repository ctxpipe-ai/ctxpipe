import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../auth/upstreamJwt.js", () => ({
  signUpstreamJwt: vi.fn().mockResolvedValue("token"),
}))

vi.mock("../../config/env.js", () => ({
  parseEnv: () => ({ AUTH_TOKEN_AUDIENCE_CODESEARCH: "codesearch" }),
}))

vi.mock("../../lib/agentToolRuntime.js", () => ({
  codesearchBaseUrl: () => "http://codesearch.test",
}))

vi.mock("../../lib/withTransientHttpRetry.js", () => ({
  withTransientHttpRetry: (fn: () => Promise<unknown>) => fn(),
}))

import { globFiles } from "./codesearchClient.js"
import { RepositoryGoneError } from "./repositoryGone.js"

describe("globFiles", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("throws RepositoryGoneError when the repository was deleted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "Repository not found or access denied",
          }),
          { status: 404 },
        ),
      ),
    )

    await expect(
      globFiles("repo_1", "org_1", { pattern: "**/*.md", onlyFiles: true }),
    ).rejects.toBeInstanceOf(RepositoryGoneError)
  })

  it("keeps other 404s as ordinary failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Path not found" }), {
          status: 404,
        }),
      ),
    )

    await expect(
      globFiles("repo_1", "org_1", { pattern: "**/*.md", onlyFiles: true }),
    ).rejects.toThrow("globFiles failed: 404: Path not found")
  })
})
