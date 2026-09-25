import { describe, expect, it } from "vitest"
import {
  clearedHyperDxGlobalAttributes,
  deepestRouteId,
  hyperdxExporterIgnoreUrls,
  hyperdxGlobalAttributes,
  hyperdxPageViewAttributes,
  isHyperDxSignInPath,
  orgSlugFromPathname,
} from "./hyperdxAttributes"

describe("hyperdxGlobalAttributes", () => {
  it("maps user and org ids and leaves email out", () => {
    expect(
      hyperdxGlobalAttributes({
        userId: "user_1",
        teamId: "org_1",
        teamName: "acme",
      }),
    ).toEqual({
      userId: "user_1",
      teamId: "org_1",
      teamName: "acme",
    })
  })

  it("uses empty strings when session or org is absent", () => {
    expect(hyperdxGlobalAttributes({})).toEqual({
      userId: "",
      teamId: "",
      teamName: "",
    })
    expect(clearedHyperDxGlobalAttributes()).toEqual({
      userId: "",
      teamId: "",
      teamName: "",
    })
  })
})

describe("hyperdxPageViewAttributes", () => {
  it("includes the deepest route id and org slug", () => {
    expect(
      hyperdxPageViewAttributes({
        path: "/acme/repositories",
        routeId: "/$orgSlug/repositories/",
        orgSlug: "acme",
      }),
    ).toEqual({
      path: "/acme/repositories",
      route: "/$orgSlug/repositories/",
      "ctxpipe.org.slug": "acme",
    })
  })
})

describe("deepestRouteId", () => {
  it("returns the last match", () => {
    expect(
      deepestRouteId([
        { routeId: "__root__" },
        { routeId: "/$orgSlug" },
        { routeId: "/$orgSlug/chat" },
      ]),
    ).toBe("/$orgSlug/chat")
    expect(deepestRouteId([])).toBe("")
    expect(deepestRouteId(undefined)).toBe("")
  })
})

describe("orgSlugFromPathname", () => {
  it("reads the org slug and skips dot-routes", () => {
    expect(orgSlugFromPathname("/acme/connectors")).toBe("acme")
    expect(orgSlugFromPathname("/.auth/sign-in")).toBe("")
    expect(orgSlugFromPathname("/.otel/v1/logs")).toBe("")
  })
})

describe("isHyperDxSignInPath", () => {
  it("matches completed sign-in views only", () => {
    expect(isHyperDxSignInPath("/.auth/sign-in")).toBe(true)
    expect(isHyperDxSignInPath("/.auth/two-factor")).toBe(true)
    expect(isHyperDxSignInPath("/.auth/callback")).toBe(true)
    expect(isHyperDxSignInPath("/.auth/sign-up")).toBe(false)
    expect(isHyperDxSignInPath("/.auth/sign-out")).toBe(false)
  })
})

describe("hyperdxExporterIgnoreUrls", () => {
  const pattern = hyperdxExporterIgnoreUrls[0]
  if (!pattern) throw new Error("missing ignore pattern")

  it("matches the same-origin exporter and not API calls", () => {
    expect(pattern.test("https://app.example/.otel/v1/traces")).toBe(true)
    expect(pattern.test("https://app.example/.otel/v1/logs")).toBe(true)
    expect(pattern.test("https://app.example/.otel/v1/metrics")).toBe(true)
    expect(pattern.test("https://app.example/.otel")).toBe(true)
    expect(pattern.test("https://app.example/acme/api/v1/repositories")).toBe(
      false,
    )
  })
})
