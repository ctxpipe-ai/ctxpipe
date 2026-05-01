/** Stable codes stored on `connections.config.provisionErrorCode` (and UI copy). */
export const FORGE_PROVISION_ERROR_CODES = [
  "forge_missing_operator_email",
  "forge_auth_failed",
  "forge_lint_failed",
  "forge_deploy_forbidden",
  "confluence_install_forbidden",
  "confluence_install_site",
  "network",
  "unknown",
] as const

export type ForgeProvisionErrorCode =
  (typeof FORGE_PROVISION_ERROR_CODES)[number]

const patterns: Array<{
  code: ForgeProvisionErrorCode
  test: (s: string) => boolean
}> = [
  {
    code: "network",
    test: (s) =>
      /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|fetch failed|getaddrinfo/i.test(s),
  },
  {
    code: "forge_auth_failed",
    test: (s) =>
      /401|unauthori[sz]ed|invalid.*token|FORGE_?API|not authenticated/i.test(
        s,
      ),
  },
  {
    code: "forge_deploy_forbidden",
    test: (s) =>
      /deploy.*forbidden|cannot deploy|403.*deploy|permission.*deploy/i.test(s),
  },
  {
    code: "confluence_install_forbidden",
    test: (s) =>
      /install.*forbidden|403.*install|not allowed to install|admin/i.test(s),
  },
  {
    code: "confluence_install_site",
    test: (s) =>
      /site.*not found|invalid site|unknown host|-s flag|confluence site/i.test(
        s,
      ),
  },
  {
    code: "forge_lint_failed",
    test: (s) => /lint|eslint|invalid manifest|Bundling failed/i.test(s),
  },
]

export function mapForgeCliOutputToErrorCode(
  exitCode: number,
  combinedStderr: string,
): ForgeProvisionErrorCode {
  if (exitCode === 0) {
    // Should not map success
    return "unknown"
  }
  const s = combinedStderr
  for (const { code, test } of patterns) {
    if (test(s)) return code
  }
  return "unknown"
}

export function userMessageForProvisionError(
  code: ForgeProvisionErrorCode,
): string {
  switch (code) {
    case "forge_missing_operator_email":
      return "Forge CLI needs the token owner’s Atlassian email — it is required on the provision form"
    case "forge_auth_failed":
      return "Check Forge scoped API token (App: Forge) at id.atlassian.com"
    case "forge_lint_failed":
      return "Bundled app invalid — contact support with the job id"
    case "forge_deploy_forbidden":
      return "This Atlassian user cannot deploy this app"
    case "confluence_install_forbidden":
      return "Account cannot install on this Confluence site (admin may be required)"
    case "confluence_install_site":
      return "Check site host and that Confluence is on this cloud site"
    case "network":
      return "Cannot reach Atlassian (firewall or DNS)"
    default:
      return "Try again; contact support with the job id if it keeps failing"
  }
}
