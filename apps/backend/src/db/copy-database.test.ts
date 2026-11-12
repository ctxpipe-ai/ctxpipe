import { describe, expect, it } from "vitest"

import { withPassword } from "./copy-database.js"

describe("withPassword", () => {
  it("adds the separate password to a URL that has none", () => {
    expect(
      withPassword(
        "postgres://master@writer.example:5432/ctxpipe?sslmode=verify-full",
        "p@ss:w/rd",
        "target",
      ),
    ).toBe(
      "postgres://master:p%40ss%3Aw%2Frd@writer.example:5432/ctxpipe?sslmode=verify-full",
    )
  })

  it("keeps the URL when no separate password is set", () => {
    const url = "postgres://master:secret@writer.example/ctxpipe"
    expect(withPassword(url, undefined, "target")).toBe(url)
  })

  it("refuses a URL that has a password and a separate password too", () => {
    expect(() =>
      withPassword(
        "postgres://master:secret@writer.example/ctxpipe",
        "other",
        "target",
      ),
    ).toThrow(
      "The target URL has a password, and a separate password is set too. Give only one.",
    )
    expect(() =>
      withPassword(
        "postgres://master@writer.example/ctxpipe?password=secret",
        "other",
        "target",
      ),
    ).toThrow(/has a password/)
  })

  it("gives a fixed message, without the URL, when the URL does not parse", () => {
    expect(() => withPassword("not a url", "pw", "target")).toThrow(
      "The target URL does not parse. Percent-encode the special characters of its password.",
    )
  })
})
