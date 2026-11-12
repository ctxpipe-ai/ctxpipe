import { describe, expect, it, vi } from "vitest"

import { preflight, withPassword } from "./copy-database.js"

describe("withPassword", () => {
  it("adds the separate password to a URL that has none", () => {
    expect(
      withPassword(
        "postgres://master@writer.example:5432/ctxpipe?sslmode=verify-full",
        "p@ss:w/rd",
      ),
    ).toBe(
      "postgres://master:p%40ss%3Aw%2Frd@writer.example:5432/ctxpipe?sslmode=verify-full",
    )
  })

  it("keeps the URL when no separate password is set", () => {
    const url = "postgres://master:secret@writer.example/ctxpipe"
    expect(withPassword(url, undefined)).toBe(url)
  })

  it("refuses a URL that has a password and a separate password too", () => {
    expect(() =>
      withPassword("postgres://master:secret@writer.example/ctxpipe", "other"),
    ).toThrow(
      "The target URL has a password, and a separate password is set too. Give only one.",
    )
    expect(() =>
      withPassword(
        "postgres://master@writer.example/ctxpipe?password=secret",
        "other",
      ),
    ).toThrow(/has a password/)
  })

  it("gives a fixed message, without the URL, when the URL does not parse", () => {
    expect(() => withPassword("not a url", "pw")).toThrow(
      "The target URL does not parse. Percent-encode the special characters of its password.",
    )
  })
})

describe("the password of each server", () => {
  it("refuses a source URL with no password, so an inherited PGPASSWORD never reaches it", async () => {
    // For example the Aurora master password, in the environment of the task.
    vi.stubEnv("PGPASSWORD", "password-of-the-other-server")
    try {
      await expect(
        preflight(
          "postgres://owner@source.example:5432/db?sslmode=verify-full",
          "postgres://master:secret@target.example:5432/db",
        ),
      ).rejects.toThrow("The source URL has no password. Give it in the URL.")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("refuses a target URL with no password and no separate password", async () => {
    await expect(
      preflight(
        "postgres://owner:secret@source.example:5432/db",
        "postgres://master@target.example:5432/db",
      ),
    ).rejects.toThrow(
      "The target URL has no password. Give it in the URL or in TARGET_DATABASE_PASSWORD.",
    )
  })
})
