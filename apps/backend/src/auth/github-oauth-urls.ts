import type { Env } from "../config/env.js"

/**
 * The two URLs of the GitHub OAuth flows: sign-in, account link, and the
 * installation proof. By default, GitHub's authorize URL and the callback of
 * this deployment. A deployment behind an OAuth forwarder sets both: the AWS
 * PR previews send them through one host, so that the preview GitHub App
 * lists one callback URL for all previews (CTX-1426). The forwarder gives the
 * `state` back as this deployment sent it, so the state check stays here.
 */
export function githubOAuthUrls(
  env: Pick<
    Env,
    "AUTH_BASE_URL" | "GITHUB_AUTHORIZE_URL" | "GITHUB_REDIRECT_URI"
  >,
) {
  return {
    authorizeUrl:
      env.GITHUB_AUTHORIZE_URL ?? "https://github.com/login/oauth/authorize",
    redirectUri:
      env.GITHUB_REDIRECT_URI ??
      `${env.AUTH_BASE_URL}/.auth/api/v1/auth/callback/github`,
  }
}
