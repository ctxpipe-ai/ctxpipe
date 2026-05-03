import { describe, expect, it } from "vitest"
import { corsOriginOption, isLoopbackBrowserOrigin } from "./corsOrigin.js"

describe("isLoopbackBrowserOrigin", () => {
  it("accepts localhost and 127.0.0.1 with any port", () => {
    expect(isLoopbackBrowserOrigin("http://localhost:6274")).toBe(true)
    expect(isLoopbackBrowserOrigin("http://127.0.0.1:3000")).toBe(true)
    expect(isLoopbackBrowserOrigin("https://localhost")).toBe(true)
  })

  it("accepts IPv6 loopback", () => {
    expect(isLoopbackBrowserOrigin("http://[::1]:8080")).toBe(true)
  })

  it("rejects non-loopback hosts", () => {
    expect(isLoopbackBrowserOrigin("https://evil.example")).toBe(false)
    expect(isLoopbackBrowserOrigin("http://192.168.1.1:3000")).toBe(false)
  })
})

describe("corsOriginOption", () => {
  it("returns * when the allowlist is empty", () => {
    expect(corsOriginOption([])).toBe("*")
  })

  it("allows listed origins and loopback dev origins", () => {
    const allow = corsOriginOption([
      "https://app.example.com",
      "https://ui.example.com",
    ])
    expect(typeof allow).toBe("function")
    const fn = allow as (origin: string) => string | null | undefined
    expect(fn("https://app.example.com")).toBe("https://app.example.com")
    expect(fn("http://localhost:6274")).toBe("http://localhost:6274")
    expect(fn("https://attacker.com")).toBeNull()
  })
})
