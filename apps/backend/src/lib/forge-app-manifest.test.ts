import { describe, expect, it } from "vitest"
import { buildForgeAppManifestYml, forgeAppIdToAri } from "./forge-app-manifest"

const exampleOrigin = "https://app.example.com"

describe("buildForgeAppManifestYml", () => {
  it("includes app id ARI when redeploying", () => {
    const y = buildForgeAppManifestYml({
      appIdAri: "ari:cloud:ecosystem::app/abc-123",
      remoteBaseUrl: exampleOrigin,
    })
    expect(y).toContain("id: ari:cloud:ecosystem::app/abc-123")
    expect(y).toContain("baseUrl: https://app.example.com")
  })

  it("omits app id for first register", () => {
    const y = buildForgeAppManifestYml({
      appIdAri: null,
      remoteBaseUrl: exampleOrigin,
    })
    expect(y).not.toMatch(/^ {2}id: /m)
    expect(y).toContain("ctxpipe-remote-forge-lifecycle")
  })

  it("rejects empty remoteBaseUrl", () => {
    expect(() =>
      buildForgeAppManifestYml({ appIdAri: null, remoteBaseUrl: "  " }),
    ).toThrow(/remoteBaseUrl/)
  })
})

describe("forgeAppIdToAri", () => {
  it("adds ari prefix for bare id", () => {
    expect(forgeAppIdToAri("4ce198e3-2ce7-4a6e-865f-a3e31d15fe43")).toBe(
      "ari:cloud:ecosystem::app/4ce198e3-2ce7-4a6e-865f-a3e31d15fe43",
    )
  })
  it("leaves full ari as-is", () => {
    const a = "ari:cloud:ecosystem::app/xyz"
    expect(forgeAppIdToAri(a)).toBe(a)
  })
  it("returns null for empty", () => {
    expect(forgeAppIdToAri("")).toBeNull()
  })
})
