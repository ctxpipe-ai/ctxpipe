import { githubInstallationIsLinked } from "@/features/connectors/queries/github-connector"

/**
 * Pure decision helper for GitHub connector “start connect” — easy to unit test.
 * Mirrors {@link useGithubConnectFlow} branching without browser APIs.
 */
type GithubConnectStartBranch =
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
  const linked = githubInstallationIsLinked(args.installation)
  if (
    args.intent === "manage_scope" &&
    !linked &&
    hosted != null &&
    hosted !== ""
  ) {
    return "managed_install"
  }
  if (linked) return "already_installed"
  if (args.installationPending) return "noop_installation_pending"
  if (hosted != null && hosted !== "") return "managed_install"
  return "self_hosted_wizard"
}

/**
 * The page where a user changes the repositories of a linked installation:
 * the App's install page that the backend names (`installUrl`). GitHub shows
 * the account picker there, as on `installations/select_target`, and gives
 * the popup's `state` back to the App's setup URL. On a deployment behind a
 * forwarder (the AWS PR previews, CTX-1441), the page is the forwarder's,
 * which accepts only `installations/new`.
 */
export function githubManageScopeUrl(
  installation: { installUrl?: string | null } | null | undefined,
): string | null {
  return installation?.installUrl || null
}

type GithubSetupOrganizationResolution =
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
