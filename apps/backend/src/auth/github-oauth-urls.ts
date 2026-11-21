import type { Env } from "../config/env.js"

type GithubUrlEnv = Pick<
  Env,
  "AUTH_BASE_URL" | "GITHUB_WEB_URL" | "GITHUB_REDIRECT_URI" | "GITHUB_APP_SLUG"
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

/** The slug of the deployment's App, as in its install links. */
export function deploymentAppSlug(env: Pick<Env, "GITHUB_APP_SLUG">) {
  return env.GITHUB_APP_SLUG?.trim() || "ctxpipe-agent"
}

/**
 * The install page of a GitHub App. GitHub gives its `state` back to the
 * App's setup URL. Only the deployment's App goes through `GITHUB_WEB_URL`
 * (a slug names one App on GitHub): the App of a wizard connection lists
 * the setup URL of this deployment's own host.
 */
export function githubAppInstallUrl(env: GithubUrlEnv, slug: string) {
  const base =
    slug === deploymentAppSlug(env) ? githubWebUrl(env) : "https://github.com"
  return `${base}/apps/${encodeURIComponent(slug)}/installations/new`
}
