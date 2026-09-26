import { describe, expect, it } from "vitest"
import {
  hyperdxGlobalAttributes,
  hyperdxPageViewAction,
  isHyperDxAuthPath,
  isHyperDxSignInPath,
  isHyperDxSignOutPath,
  orgSlugFromPathname,
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
      "enduser.id": "user_1",
      "ctxpipe.org.id": "org_1",
      "ctxpipe.org.slug": "acme",
    })
  })

  it("omits empty identity keys instead of publishing empty strings", () => {
    expect(hyperdxGlobalAttributes({})).toEqual({})
    expect(
      hyperdxGlobalAttributes({
        userId: "user_1",
        teamId: "",
        teamName: "",
      }),
    ).toEqual({
      userId: "user_1",
      "enduser.id": "user_1",
    })
  })
})

describe("hyperdxPageViewAction", () => {
  it("uses the route template and the pathname", () => {
    expect(
      hyperdxPageViewAction({
        pathname: "/acme/repositories",
        routeId: "/$orgSlug/repositories/",
      }),
    ).toEqual({
      path: "/acme/repositories",
      "url.path": "/acme/repositories",
      route: "/$orgSlug/repositories/",
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
})

describe("orgSlugFromPathname", () => {
  it("reads the first segment and ignores auth and onboarding", () => {
    expect(orgSlugFromPathname("/acme/chat")).toBe("acme")
    expect(orgSlugFromPathname("/.auth/sign-in")).toBe("")
    expect(orgSlugFromPathname("/onboarding")).toBe("")
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

describe("isHyperDxSignOutPath", () => {
  it("matches the sign-out view only", () => {
    expect(isHyperDxSignOutPath("/.auth/sign-out")).toBe(true)
    expect(isHyperDxSignOutPath("/.auth/sign-out/")).toBe(true)
    expect(isHyperDxSignOutPath("/.auth/sign-in")).toBe(false)
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
