import type { Env } from "../config/env.js"

type GithubUrlEnv = Pick<
  Env,
  "AUTH_BASE_URL" | "GITHUB_WEB_URL" | "GITHUB_REDIRECT_URI"
>

/**
 * The base URL of the GitHub pages that the browser opens for the
 * deployment's App: `https://github.com`, or `GITHUB_WEB_URL` when a
 * forwarder serves them. The AWS PR previews send these pages and the
 * callback through one host, so that the preview GitHub App lists one
 * callback URL and one setup URL for all previews (CTX-1441). The forwarder
 * marks the `state` on the way to GitHub and removes the mark on the way
 * back, so the state check stays here.
 */
function githubWebUrl(env: GithubUrlEnv) {
  return (env.GITHUB_WEB_URL ?? "https://github.com").replace(/\/+$/, "")
}

/**
 * The two URLs of the GitHub OAuth flows: sign-in, account link, and the
 * installation proof. The callback is this deployment's, or
 * `GITHUB_REDIRECT_URI` behind a forwarder.
 */
export function githubOAuthUrls(env: GithubUrlEnv) {
  return {
    authorizeUrl: `${githubWebUrl(env)}/login/oauth/authorize`,
    redirectUri:
      env.GITHUB_REDIRECT_URI ??
      `${env.AUTH_BASE_URL}/.auth/api/v1/auth/callback/github`,
  }
}

/**
 * The install page of the deployment's App. GitHub gives its `state` back
 * to the App's setup URL. An App of a wizard connection is not the
 * deployment's App: its install page is on github.com.
 */
export function githubDeploymentAppInstallUrl(
  env: GithubUrlEnv,
  slug: string,
) {
  return `${githubWebUrl(env)}/apps/${encodeURIComponent(slug)}/installations/new`
}
