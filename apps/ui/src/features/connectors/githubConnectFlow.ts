/**
 * Pure decision helper for GitHub connector “start connect” — easy to unit test.
 * Mirrors {@link useGithubConnectFlow} branching without browser APIs.
 */
export type GithubConnectStartBranch =
  | "noop_bootstrap_pending"
  | "noop_installation_pending"
  | "already_installed"
  | "managed_install"
  | "self_hosted_wizard"

export function getGithubConnectStartBranch(args: {
  installationPending: boolean
  installation: unknown
  bootstrapPending: boolean
  hostedDefaultAppInstallUrl: string | null | undefined
  intent: "connect" | "manage_scope"
}): GithubConnectStartBranch {
  if (args.bootstrapPending) return "noop_bootstrap_pending"
  const hosted = args.hostedDefaultAppInstallUrl
  if (
    args.intent === "manage_scope" &&
    !args.installation &&
    hosted != null &&
    hosted !== ""
  ) {
    return "managed_install"
  }
  if (args.installation) return "already_installed"
  if (args.installationPending) return "noop_installation_pending"
  if (hosted != null && hosted !== "") return "managed_install"
  return "self_hosted_wizard"
}

export type GithubSetupOrganizationResolution =
  | { kind: "existing"; orgSlug: string }
  | { kind: "selected"; orgSlug: string }
  | { kind: "missing" }

export function resolveGithubSetupOrganization(args: {
  existingOrgSlug: string | null | undefined
  candidateOrgSlug: string | null | undefined
  organizationSlugs: string[]
}): GithubSetupOrganizationResolution {
  if (args.existingOrgSlug) {
    return { kind: "existing", orgSlug: args.existingOrgSlug }
  }

  if (
    args.candidateOrgSlug &&
    args.organizationSlugs.includes(args.candidateOrgSlug)
  ) {
    return { kind: "selected", orgSlug: args.candidateOrgSlug }
  }

  return { kind: "missing" }
}
