import { describe, expect, it } from "vitest"
import { isGithubInstallationTokenError } from "./github-installation.js"

describe("isGithubInstallationTokenError", () => {
  it("matches 404 mint failures without treating other errors as token drift", () => {
    expect(
      isGithubInstallationTokenError({
        status: 404,
        message: "Not Found - create-an-installation-access-token-for-an-app",
      }),
    ).toBe(true)
    expect(
      isGithubInstallationTokenError(
        new Error(
          "Not Found - https://docs.github.com/rest/reference/apps#create-an-installation-access-token-for-an-app",
        ),
      ),
    ).toBe(true)
    expect(isGithubInstallationTokenError(new Error("ENOTFOUND"))).toBe(false)
    expect(isGithubInstallationTokenError({ status: 500 })).toBe(false)
  })
})
