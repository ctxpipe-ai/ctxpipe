import { describe, expect, it } from "vitest"
import {
  clearedHyperDxGlobalAttributes,
  deepestRouteId,
  hyperdxExporterIgnoreUrls,
  hyperdxGlobalAttributes,
  hyperdxPageViewAttributes,
  hyperdxPageViewFromMatches,
  isHyperDxAuthPath,
  isHyperDxSignInPath,
  orgSlugFromMatches,
  readActiveOrganizationId,
  resolveHyperDxTeam,
  routerLocationMatchesResolved,
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
      "enduser.id": "user_1",
      "ctxpipe.org.id": "org_1",
      "ctxpipe.org.slug": "acme",
    })
  })

  it("omits empty identity keys instead of publishing empty strings", () => {
    expect(hyperdxGlobalAttributes({})).toEqual({})
    expect(clearedHyperDxGlobalAttributes()).toEqual({})
    expect(
      hyperdxGlobalAttributes({
        userId: "user_1",
        teamId: "",
        teamName: "obs-e2e-343",
      }),
    ).toEqual({
      userId: "user_1",
      teamName: "obs-e2e-343",
      "enduser.id": "user_1",
      "ctxpipe.org.slug": "obs-e2e-343",
    })
    expect(
      hyperdxGlobalAttributes({
        userId: "user_1",
        teamId: "org_1",
        teamName: "obs-e2e-343",
      }),
    ).toEqual({
      userId: "user_1",
      teamId: "org_1",
      teamName: "obs-e2e-343",
      "enduser.id": "user_1",
      "ctxpipe.org.id": "org_1",
      "ctxpipe.org.slug": "obs-e2e-343",
    })
    for (const value of Object.values(
      hyperdxGlobalAttributes({ teamName: "obs-e2e-343" }),
    )) {
      expect(value).not.toBe("")
    }
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
      "url.path": "/acme/repositories",
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

describe("routerLocationMatchesResolved", () => {
  it("waits until the deepest match pathname is the location", () => {
    expect(
      routerLocationMatchesResolved("/obs-e2e-343/chat", [
        { routeId: "/.auth/sign-in", pathname: "/.auth/sign-in" },
      ]),
    ).toBe(false)
    expect(
      routerLocationMatchesResolved("/obs-e2e-343/chat", [
        { routeId: "/$orgSlug", pathname: "/obs-e2e-343" },
        { routeId: "/$orgSlug/chat", pathname: "/obs-e2e-343/chat" },
      ]),
    ).toBe(true)
    expect(
      routerLocationMatchesResolved("/obs-e2e-343", [
        { routeId: "/$orgSlug/", pathname: "/obs-e2e-343/" },
      ]),
    ).toBe(true)
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
      "url.path": "/obs-e2e-343/chat",
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
      "url.path": "/onboarding",
      route: "/onboarding",
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

  it("does not pair an active organization id with a different route slug", () => {
    expect(
      resolveHyperDxTeam({
        orgSlugFromRoute: "obs-e2e-343",
        organizations: [],
        activeOrganizationId: "org_1",
      }),
    ).toEqual({ teamId: "", teamName: "obs-e2e-343" })
    expect(
      resolveHyperDxTeam({
        orgSlugFromRoute: "other",
        organizations,
        activeOrganizationId: "org_1",
      }),
    ).toEqual({ teamId: "", teamName: "other" })
  })

  it("uses the route org even when the active organization is a different record", () => {
    expect(
      resolveHyperDxTeam({
        orgSlugFromRoute: "beta",
        organizations: [
          { id: "org_1", slug: "obs-e2e-343" },
          { id: "org_b", slug: "beta" },
        ],
        activeOrganizationId: "org_1",
      }),
    ).toEqual({ teamId: "org_b", teamName: "beta" })
  })

  it("uses the active organization id on routes without an org slug before the list loads", () => {
    expect(
      resolveHyperDxTeam({
        orgSlugFromRoute: "",
        organizations: [],
        activeOrganizationId: "org_1",
      }),
    ).toEqual({ teamId: "org_1", teamName: "" })
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

describe("isHyperDxAuthPath", () => {
  it("matches auth pages and not org routes", () => {
    expect(isHyperDxAuthPath("/.auth")).toBe(true)
    expect(isHyperDxAuthPath("/.auth/device")).toBe(true)
    expect(isHyperDxAuthPath("/.auth/sign-in")).toBe(true)
    expect(isHyperDxAuthPath("/obs-e2e-343")).toBe(false)
    expect(isHyperDxAuthPath("/onboarding")).toBe(false)
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
