import { describe, expect, it } from "vitest"

import { asSentence } from "./sentence"

describe("asSentence", () => {
  it("adds a period to a text with no end mark", () => {
    expect(asSentence("stdout maxBuffer length exceeded")).toBe(
      "stdout maxBuffer length exceeded.",
    )
  })

  it("keeps a final period, question mark or exclamation mark", () => {
    expect(asSentence("The run stopped.")).toBe("The run stopped.")
    expect(asSentence("Is the server down?")).toBe("Is the server down?")
    expect(asSentence("Try again!")).toBe("Try again!")
  })

  it("removes trailing white space", () => {
    expect(asSentence("Connected app not found \n")).toBe(
      "Connected app not found.",
    )
    expect(asSentence("Done. ")).toBe("Done.")
  })

  it("keeps an empty text empty", () => {
    expect(asSentence("")).toBe("")
    expect(asSentence("  ")).toBe("")
  })
})
