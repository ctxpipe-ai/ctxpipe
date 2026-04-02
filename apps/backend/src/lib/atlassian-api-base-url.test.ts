import { describe, expect, it } from "vitest"
import {
  parseAtlassianApiBaseUrlFromFitPayload,
  resolveAtlassianConfluenceApiBaseUrl,
  validateAtlassianProductApiBaseUrl,
} from "./atlassian-api-base-url.js"

describe("validateAtlassianProductApiBaseUrl", () => {
  it("accepts https api.atlassian.com with path", () => {
    expect(
      validateAtlassianProductApiBaseUrl(
        "https://api.atlassian.com/ex/confluence/4c822e2f-510f-48b9-b8d0-8419d0932949",
      ),
    ).toBe(
      "https://api.atlassian.com/ex/confluence/4c822e2f-510f-48b9-b8d0-8419d0932949",
    )
  })

  it("strips trailing slashes", () => {
    expect(
      validateAtlassianProductApiBaseUrl(
        "https://api.atlassian.com/ex/confluence/uuid/",
      ),
    ).toBe("https://api.atlassian.com/ex/confluence/uuid")
  })

  it("rejects http", () => {
    expect(
      validateAtlassianProductApiBaseUrl(
        "http://api.atlassian.com/ex/confluence/x",
      ),
    ).toBeUndefined()
  })

  it("rejects wrong host", () => {
    expect(
      validateAtlassianProductApiBaseUrl("https://evil.com/ex/confluence/x"),
    ).toBeUndefined()
  })

  it("rejects origin-only URL", () => {
    expect(
      validateAtlassianProductApiBaseUrl("https://api.atlassian.com/"),
    ).toBeUndefined()
  })
})

describe("parseAtlassianApiBaseUrlFromFitPayload", () => {
  it("reads app.apiBaseUrl", () => {
    expect(
      parseAtlassianApiBaseUrlFromFitPayload({
        app: {
          apiBaseUrl: "https://api.atlassian.com/ex/confluence/abc",
        },
      }),
    ).toBe("https://api.atlassian.com/ex/confluence/abc")
  })

  it("returns undefined when app missing", () => {
    expect(parseAtlassianApiBaseUrlFromFitPayload({ sub: "x" })).toBeUndefined()
  })
})

describe("resolveAtlassianConfluenceApiBaseUrl", () => {
  it("prefers stored FIT base URL", () => {
    expect(
      resolveAtlassianConfluenceApiBaseUrl({
        cloudId: "c1",
        atlassianApiBaseUrl: "https://api.atlassian.com/ex/confluence/from-fit",
      }),
    ).toBe("https://api.atlassian.com/ex/confluence/from-fit")
  })

  it("falls back to cloudId template when null", () => {
    expect(
      resolveAtlassianConfluenceApiBaseUrl({
        cloudId: "c1",
        atlassianApiBaseUrl: null,
      }),
    ).toBe("https://api.atlassian.com/ex/confluence/c1")
  })
})
