import { describe, expect, it } from "vitest"
import {
  getGithubConnectStartBranch,
  githubInstallationIsLinked,
  resolveGithubSetupOrganization,
} from "./githubConnectFlow"

describe("githubInstallationIsLinked", () => {
  it("requires a numeric installationId", () => {
    expect(githubInstallationIsLinked({ installationId: 9 })).toBe(true)
    expect(githubInstallationIsLinked({ installationId: null })).toBe(false)
    expect(githubInstallationIsLinked({ id: "con_1" })).toBe(false)
    expect(githubInstallationIsLinked(null)).toBe(false)
  })
})

describe("getGithubConnectStartBranch", () => {
  it("returns noop when bootstrap is pending", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: true,
        installationPending: false,
        installation: null,
        hostedDefaultAppInstallUrl: null,
        intent: "connect",
      }),
    ).toBe("noop_bootstrap_pending")
  })

  it("returns already_installed when the App is linked", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: false,
        installationPending: false,
        installation: { id: "con_1", installationId: 42 },
        hostedDefaultAppInstallUrl: null,
        intent: "connect",
      }),
    ).toBe("already_installed")
  })

  it("does not treat a draft connection as already installed", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: false,
        installationPending: false,
        installation: { id: "con_1", installationId: null },
        hostedDefaultAppInstallUrl:
          "https://github.com/apps/ctxpipe-agent/installations/new",
        intent: "connect",
      }),
    ).toBe("managed_install")
  })

  it("keeps already_installed precedence over installation pending", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: false,
        installationPending: true,
        installation: { id: "con_1", installationId: 42 },
        hostedDefaultAppInstallUrl:
          "https://github.com/apps/ctxpipe-agent/installations/new",
        intent: "connect",
      }),
    ).toBe("already_installed")
  })

  it("returns noop when installation query is still pending", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: false,
        installationPending: true,
        installation: undefined,
        hostedDefaultAppInstallUrl:
          "https://github.com/apps/foo/installations/new",
        intent: "connect",
      }),
    ).toBe("noop_installation_pending")
  })

  it("returns managed_install when hosted URL is set and no installation", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: false,
        installationPending: false,
        installation: null,
        hostedDefaultAppInstallUrl:
          "https://github.com/apps/ctxpipe-agent/installations/new",
        intent: "connect",
      }),
    ).toBe("managed_install")
  })

  it("returns managed_install for manage_scope intent without installation", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: false,
        installationPending: false,
        installation: null,
        hostedDefaultAppInstallUrl:
          "https://github.com/apps/ctxpipe-agent/installations/new",
        intent: "manage_scope",
      }),
    ).toBe("managed_install")
  })

  it("returns already_installed for manage_scope when installation exists", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: false,
        installationPending: false,
        installation: { id: "con_1", installationId: 42 },
        hostedDefaultAppInstallUrl:
          "https://github.com/apps/ctxpipe-agent/installations/new",
        intent: "manage_scope",
      }),
    ).toBe("already_installed")
  })

  it("returns self_hosted_wizard when hosted URL is null (no public-app fallback)", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: false,
        installationPending: false,
        installation: null,
        hostedDefaultAppInstallUrl: null,
        intent: "connect",
      }),
    ).toBe("self_hosted_wizard")
  })
})

describe("resolveGithubSetupOrganization", () => {
  it("uses the organization already linked to an installation update", () => {
    expect(
      resolveGithubSetupOrganization({
        existingOrgSlug: "acme",
        candidateOrgSlug: null,
        organizationSlugs: [],
      }),
    ).toEqual({ kind: "existing", orgSlug: "acme" })
  })

  it("prefers the existing installation organization over a stale hint", () => {
    expect(
      resolveGithubSetupOrganization({
        existingOrgSlug: "acme",
        candidateOrgSlug: "other",
        organizationSlugs: ["other"],
      }),
    ).toEqual({ kind: "existing", orgSlug: "acme" })
  })

  it("uses a valid selected organization for a new installation", () => {
    expect(
      resolveGithubSetupOrganization({
        existingOrgSlug: null,
        candidateOrgSlug: "acme",
        organizationSlugs: ["acme"],
      }),
    ).toEqual({ kind: "selected", orgSlug: "acme" })
  })

  it("requires organization selection for an unlinked installation", () => {
    expect(
      resolveGithubSetupOrganization({
        existingOrgSlug: null,
        candidateOrgSlug: null,
        organizationSlugs: ["acme"],
      }),
    ).toEqual({ kind: "missing" })
  })
})
