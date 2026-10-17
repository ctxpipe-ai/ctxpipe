import { describe, expect, it } from "vitest"
import { inLanguage } from "./languages.js"

describe("inLanguage", () => {
  it("counts a .h header as C and as C++", () => {
    expect(inLanguage("c", { path: "include/api.h" })).toBe(true)
    expect(inLanguage("cpp", { path: "include/api.h" })).toBe(true)
    expect(inLanguage("typescript", { path: "include/api.h" })).toBe(false)
  })

  it("keeps the other extensions apart", () => {
    expect(inLanguage("cpp", { path: "src/a.cc" })).toBe(true)
    expect(inLanguage("cpp", { path: "src/a.c" })).toBe(false)
  })
})
