import { describe, expect, it } from "vitest"
import {
  getOAuthValidAudiences,
  registerOAuthResourceAudience,
} from "./audiences.js"

describe("getOAuthValidAudiences", () => {
  it("always includes the base audience", () => {
    const audiences = getOAuthValidAudiences("https://backend.example.com")

    expect(audiences).toContain("https://backend.example.com/")
  })

  it("registers org-scoped MCP resource audiences from same origin", () => {
    registerOAuthResourceAudience(
      "https://backend.example.com/acme/mcp",
      "https://backend.example.com",
    )
    registerOAuthResourceAudience(
      "https://backend.example.com/acme/mcp",
      "https://backend.example.com",
    )

    const audiences = getOAuthValidAudiences("https://backend.example.com")
    expect(audiences).toContain("https://backend.example.com/acme/mcp")
  })

  it("ignores non-MCP or cross-origin resources", () => {
    registerOAuthResourceAudience(
      "https://malicious.example.com/acme/mcp",
      "https://backend.example.com",
    )
    registerOAuthResourceAudience(
      "https://backend.example.com/not-mcp",
      "https://backend.example.com",
    )

    const audiences = getOAuthValidAudiences("https://backend.example.com")
    expect(audiences).not.toContain("https://malicious.example.com/acme/mcp")
    expect(audiences).not.toContain("https://backend.example.com/not-mcp")
  })
})
