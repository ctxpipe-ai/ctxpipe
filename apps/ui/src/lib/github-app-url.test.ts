import { describe, expect, it } from "vitest"

import { githubGrantAccessUrls } from "./github-app-url"

describe("githubGrantAccessUrls", () => {
  it("uses the install URL, not the settings manage URL", () => {
    expect(
      githubGrantAccessUrls({
        installUrl: "https://github.com/apps/ctxpipe-agent/installations/new",
        manageUrl: "https://github.com/settings/installations/123",
      }),
    ).toEqual(["https://github.com/apps/ctxpipe-agent/installations/new"])
  })

  it("falls back to the manage URL only when the install URL is missing", () => {
    expect(
      githubGrantAccessUrls({
        manageUrl: "https://github.com/settings/installations/123",
      }),
    ).toEqual(["https://github.com/settings/installations/123"])
  })
})
