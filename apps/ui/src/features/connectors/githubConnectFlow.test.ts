import { describe, expect, it } from "vitest"
import { getGithubConnectStartBranch } from "./githubConnectFlow"

describe("getGithubConnectStartBranch", () => {
  it("returns noop when bootstrap is pending", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: true,
        installationPending: false,
        installation: null,
        hostedDefaultAppInstallUrl: null,
      }),
    ).toBe("noop_bootstrap_pending")
  })

  it("returns already_installed when installation is linked", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: false,
        installationPending: false,
        installation: { id: "con_1", installationId: 42 },
        hostedDefaultAppInstallUrl: null,
      }),
    ).toBe("already_installed")
  })

  it("returns managed_install when only an unlinked draft row exists", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: false,
        installationPending: false,
        installation: { id: "con_draft", installationId: null },
        hostedDefaultAppInstallUrl:
          "https://github.com/apps/ctxpipe-agent/installations/select_target",
      }),
    ).toBe("managed_install")
  })

  it("returns noop when installation query is still pending", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: false,
        installationPending: true,
        installation: undefined,
        hostedDefaultAppInstallUrl:
          "https://github.com/apps/foo/installations/select_target",
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
          "https://github.com/apps/ctxpipe-agent/installations/select_target",
      }),
    ).toBe("managed_install")
  })

  it("returns self_hosted_wizard when hosted URL is null (no public-app fallback)", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: false,
        installationPending: false,
        installation: null,
        hostedDefaultAppInstallUrl: null,
      }),
    ).toBe("self_hosted_wizard")
  })
})
