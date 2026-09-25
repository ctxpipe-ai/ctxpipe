import { describe, expect, it } from "vitest"
import {
  clearedHyperDxGlobalAttributes,
  deepestRouteId,
  hyperdxExporterIgnoreUrls,
  hyperdxGlobalAttributes,
  hyperdxPageViewAttributes,
  hyperdxPageViewFromMatches,
  isHyperDxSignInPath,
  orgSlugFromMatches,
  readActiveOrganizationId,
  resolveHyperDxTeam,
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

describe("orgSlugFromMatches", () => {
  it("reads the orgSlug param and ignores non-org routes", () => {
    expect(
      orgSlugFromMatches([
        { routeId: "__root__", params: {} },
        { routeId: "/$orgSlug", params: { orgSlug: "obs-e2e-343" } },
        { routeId: "/$orgSlug/chat", params: { orgSlug: "obs-e2e-343" } },
      ]),
    ).toBe("obs-e2e-343")
    expect(orgSlugFromMatches([{ routeId: "/onboarding", params: {} }])).toBe(
      "",
    )
    expect(
      orgSlugFromMatches([{ routeId: "/.auth/sign-in", params: {} }]),
    ).toBe("")
  })
})

describe("hyperdxPageViewFromMatches", () => {
  it("uses the deepest route id and the org param, not the first path segment", () => {
    expect(
      hyperdxPageViewFromMatches({
        pathname: "/obs-e2e-343/chat",
        matches: [
          { routeId: "__root__" },
          { routeId: "/$orgSlug", params: { orgSlug: "obs-e2e-343" } },
          { routeId: "/$orgSlug/chat", params: { orgSlug: "obs-e2e-343" } },
        ],
      }),
    ).toEqual({
      path: "/obs-e2e-343/chat",
      route: "/$orgSlug/chat",
      "ctxpipe.org.slug": "obs-e2e-343",
    })
    expect(
      hyperdxPageViewFromMatches({
        pathname: "/onboarding",
        matches: [{ routeId: "/onboarding" }],
      }),
    ).toEqual({
      path: "/onboarding",
      route: "/onboarding",
      "ctxpipe.org.slug": "",
    })
  })
})

describe("resolveHyperDxTeam", () => {
  const organizations = [{ id: "org_1", slug: "obs-e2e-343" }]

  it("uses the route org when the list contains it", () => {
    expect(
      resolveHyperDxTeam({
        orgSlugFromRoute: "obs-e2e-343",
        organizations,
        activeOrganizationId: "",
      }),
    ).toEqual({ teamId: "org_1", teamName: "obs-e2e-343" })
  })

  it("keeps the route slug before the org list includes it", () => {
    expect(
      resolveHyperDxTeam({
        orgSlugFromRoute: "obs-e2e-343",
        organizations: [],
        activeOrganizationId: "org_1",
      }),
    ).toEqual({ teamId: "", teamName: "obs-e2e-343" })
  })

  it("falls back to the session active organization off org routes", () => {
    expect(
      resolveHyperDxTeam({
        orgSlugFromRoute: "",
        organizations,
        activeOrganizationId: "org_1",
      }),
    ).toEqual({ teamId: "org_1", teamName: "obs-e2e-343" })
  })

  it("does not treat onboarding as an org", () => {
    expect(
      resolveHyperDxTeam({
        orgSlugFromRoute: "",
        organizations,
        activeOrganizationId: "",
      }),
    ).toEqual({ teamId: "", teamName: "" })
  })
})

describe("readActiveOrganizationId", () => {
  it("reads the session field and ignores anything else", () => {
    expect(readActiveOrganizationId({ activeOrganizationId: "org_1" })).toBe(
      "org_1",
    )
    expect(readActiveOrganizationId(null)).toBe("")
    expect(readActiveOrganizationId({ activeOrganizationId: 1 })).toBe("")
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
