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
  installation: { installationId?: number | null } | null | undefined
  bootstrapPending: boolean
  hostedDefaultAppInstallUrl: string | null | undefined
}): GithubConnectStartBranch {
  if (args.bootstrapPending) return "noop_bootstrap_pending"
  if (args.installation?.installationId != null) return "already_installed"
  if (args.installationPending) return "noop_installation_pending"
  const hosted = args.hostedDefaultAppInstallUrl
  if (hosted != null && hosted !== "") return "managed_install"
  return "self_hosted_wizard"
}
