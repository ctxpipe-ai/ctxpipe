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
        intent: "connect",
      }),
    ).toBe("noop_bootstrap_pending")
  })

  it("returns already_installed when installation exists", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: false,
        installationPending: false,
        installation: { id: "con_1" },
        hostedDefaultAppInstallUrl: null,
        intent: "connect",
      }),
    ).toBe("already_installed")
  })

  it("keeps already_installed precedence over installation pending", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: false,
        installationPending: true,
        installation: { id: "con_1" },
        hostedDefaultAppInstallUrl:
          "https://github.com/apps/ctxpipe-agent/installations/select_target",
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
          "https://github.com/apps/foo/installations/select_target",
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
          "https://github.com/apps/ctxpipe-agent/installations/select_target",
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
          "https://github.com/apps/ctxpipe-agent/installations/select_target",
        intent: "manage_scope",
      }),
    ).toBe("managed_install")
  })

  it("returns already_installed for manage_scope when installation exists", () => {
    expect(
      getGithubConnectStartBranch({
        bootstrapPending: false,
        installationPending: false,
        installation: { id: "con_1" },
        hostedDefaultAppInstallUrl:
          "https://github.com/apps/ctxpipe-agent/installations/select_target",
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
