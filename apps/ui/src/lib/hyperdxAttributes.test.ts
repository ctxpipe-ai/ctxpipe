import { describe, expect, it } from "vitest"
import {
  hyperdxGlobalAttributes,
  hyperdxIdentity,
  hyperdxIdentityAfterSession,
  hyperdxPageViewAction,
  isHyperDxAuthPath,
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

  it("publishes empty strings for missing ids", () => {
    expect(hyperdxGlobalAttributes({})).toEqual({
      userId: "",
      teamId: "",
      teamName: "",
      "enduser.id": "",
      "ctxpipe.org.id": "",
      "ctxpipe.org.slug": "",
    })
    expect(
      hyperdxGlobalAttributes({
        userId: "user_1",
        teamId: "",
        teamName: "",
      }),
    ).toEqual({
      userId: "user_1",
      teamId: "",
      teamName: "",
      "enduser.id": "user_1",
      "ctxpipe.org.id": "",
      "ctxpipe.org.slug": "",
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

describe("hyperdxIdentity", () => {
  const session = {
    user: { id: "user_1" },
    session: { activeOrganizationId: "org_1" },
  }
  const organizations = [
    { id: "org_1", slug: "acme" },
    { id: "org_2", slug: "beta" },
  ]

  it("uses the route org from the same record", () => {
    expect(hyperdxIdentity(session, organizations, "/beta/chat")).toEqual({
      userId: "user_1",
      teamId: "org_2",
      teamName: "beta",
    })
  })

  it("does not pair another org id with an unknown route slug", () => {
    expect(hyperdxIdentity(session, organizations, "/other")).toEqual({
      userId: "user_1",
      teamId: "",
      teamName: "other",
    })
  })

  it("omits org keys on auth pages and returns nothing on sign-out", () => {
    expect(hyperdxIdentity(session, organizations, "/.auth/sign-in")).toEqual({
      userId: "user_1",
      teamId: "",
      teamName: "",
    })
    expect(
      hyperdxIdentity(session, organizations, "/.auth/sign-out"),
    ).toBeNull()
  })
})

describe("hyperdxIdentityAfterSession", () => {
  const session = {
    user: { id: "user_1" },
    session: { activeOrganizationId: "org_1" },
  }
  const documentIdentity = {
    userId: "user_1",
    teamId: "org_1",
    teamName: "acme",
  }

  it("keeps the SSR team id while the org list is still null", () => {
    expect(
      hyperdxIdentityAfterSession({
        session,
        organizations: null,
        pathname: "/acme/repositories",
        documentIdentity,
      }),
    ).toEqual(documentIdentity)
    expect(
      hyperdxIdentityAfterSession({
        session,
        organizations: undefined,
        pathname: "/onboarding",
        documentIdentity,
      }),
    ).toEqual(documentIdentity)
  })

  it("publishes the listed org, and a different route slug, once it can", () => {
    expect(
      hyperdxIdentityAfterSession({
        session,
        organizations: [{ id: "org_1", slug: "acme" }],
        pathname: "/acme/repositories",
        documentIdentity,
      }),
    ).toEqual(documentIdentity)
    expect(
      hyperdxIdentityAfterSession({
        session,
        organizations: null,
        pathname: "/beta",
        documentIdentity,
      }),
    ).toEqual({ userId: "user_1", teamId: "", teamName: "beta" })
  })
})
