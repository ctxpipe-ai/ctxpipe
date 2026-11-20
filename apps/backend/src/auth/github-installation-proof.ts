import { createHash, randomBytes } from "node:crypto"

import { and, eq, gt } from "drizzle-orm"
import type { Context } from "hono"
import { Octokit } from "octokit"
import { z } from "zod"

import type { AppEnv } from "../app/env.js"
import type { Env } from "../config/env.js"
import { getSystemDb } from "../db/client.js"
import { verifications } from "../db/schema/auth.js"
import { attachGithubInstallation } from "../domain/github-installation-attach.js"
import { generateObjectId } from "../lib/id.js"
import { githubRowHasOwnApp } from "../models/connection-rows.js"
import {
  getGithubConnectionRow,
  userCanAccessInstallation,
} from "../models/github-installation.js"
import { getLogger } from "../observability/logger.js"
import { getAuth } from "./config.js"
import { githubOAuthUrls } from "./github-oauth-urls.js"
import { hasOrgAdminOrOwnerRole } from "./withAuth.js"

/**
 * Proof of installation access without a login link (CTX-1429). The acting
 * org admin authorizes the deployment's GitHub App once. The callback
 * exchanges the code for a short-lived user token, checks that the token can
 * see the installation, revokes the token at GitHub, and attaches the
 * installation. Nothing stores the token, and no account link is made or
 * changed.
 *
 * The callback uses the redirect URI of GitHub sign-in, because that is the
 * callback URL that the App lists ({@link githubOAuthUrls}). The `state`
 * prefix tells the two flows apart.
 */
const STATE_PREFIX = "gh-installation."

/** What a proof is bound to. It stays on the server, in the nonce row. */
const ProofSchema = z.object({
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  userId: z.string().min(1),
  installationId: z.number().int().positive(),
  connectionId: z.string().min(1).optional(),
  codeVerifier: z.string().min(1),
})

type Proof = z.infer<typeof ProofSchema>

function verificationIdentifier(nonce: string) {
  return `github-installation-proof:${nonce}`
}

/**
 * The GitHub authorize URL for one proof, or `undefined` when the deployment
 * has no GitHub App client. The `state` is a random nonce. Only its server
 * row holds the org, the user, the installation and the PKCE verifier, and
 * the row expires after 10 minutes. The callback deletes the row, so each
 * state works one time only.
 */
export async function createGithubInstallationProofUrl(
  env: Env,
  proof: Omit<Proof, "codeVerifier">,
): Promise<string | undefined> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return undefined
  const nonce = randomBytes(16).toString("base64url")
  const codeVerifier = randomBytes(32).toString("base64url")
  await getSystemDb()
    .insert(verifications)
    .values({
      id: generateObjectId("ver"),
      identifier: verificationIdentifier(nonce),
      value: JSON.stringify({ ...proof, codeVerifier } satisfies Proof),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    })
  const { authorizeUrl, redirectUri } = githubOAuthUrls(env)
  const url = new URL(authorizeUrl)
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("state", `${STATE_PREFIX}${nonce}`)
  url.searchParams.set(
    "code_challenge",
    createHash("sha256").update(codeVerifier).digest("base64url"),
  )
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("allow_signup", "false")
  return url.toString()
}

export function isGithubInstallationProofState(state: string | undefined) {
  return state?.startsWith(STATE_PREFIX) ?? false
}

/** Deletes the nonce row of `state`, so a second use finds nothing. */
async function consumeProof(state: string): Promise<Proof | undefined> {
  const nonce = state.slice(STATE_PREFIX.length)
  if (!nonce) return undefined
  const [row] = await getSystemDb()
    .delete(verifications)
    .where(
      and(
        eq(verifications.identifier, verificationIdentifier(nonce)),
        gt(verifications.expiresAt, new Date()),
      ),
    )
    .returning({ value: verifications.value })
  if (!row) return undefined
  try {
    return ProofSchema.parse(JSON.parse(row.value))
  } catch {
    return undefined
  }
}

/** The user token for `code`, or `undefined` when GitHub does not give one. */
async function exchangeCode(input: {
  env: Env
  code: string
  codeVerifier: string
}): Promise<string | undefined> {
  try {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: input.env.GITHUB_CLIENT_ID,
        client_secret: input.env.GITHUB_CLIENT_SECRET,
        code: input.code,
        redirect_uri: githubOAuthUrls(input.env).redirectUri,
        code_verifier: input.codeVerifier,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as { access_token?: unknown }
    return typeof body.access_token === "string" && body.access_token
      ? body.access_token
      : undefined
  } catch {
    // A timeout or a network failure: the proof fails.
    return undefined
  }
}

/**
 * Revokes the proof token at GitHub (CTX-1434), so that it cannot be used
 * after the proof. A failed revoke does not stop the attach. The log entry
 * does not hold the token.
 */
async function revokeToken(env: Env, token: string) {
  try {
    const res = await fetch(
      `https://api.github.com/applications/${encodeURIComponent(env.GITHUB_CLIENT_ID ?? "")}/token`,
      {
        method: "DELETE",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Basic ${Buffer.from(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ access_token: token }),
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (res.ok) return
    getLogger().warn("github_installation.proof_token_revoke_failed", {
      status: res.status,
    })
  } catch (e) {
    getLogger().warn("github_installation.proof_token_revoke_failed", {
      error: e instanceof Error ? e.name : "unknown",
    })
  }
}

/**
 * The GitHub callback for a state from {@link createGithubInstallationProofUrl}.
 * It needs the browser session of the user who started the flow, so a link
 * that another person opens does nothing.
 */
export async function githubInstallationProofCallback(c: Context<AppEnv>) {
  const env = c.var.env
  const toConnectors = (orgSlug: string | undefined, description: string) => {
    const url = new URL(
      orgSlug ? `/${encodeURIComponent(orgSlug)}/connectors` : "/",
      env.AUTH_BASE_URL,
    )
    url.searchParams.set("error", "github_installation_proof_failed")
    url.searchParams.set("error_description", description)
    return c.redirect(url.toString(), 302)
  }
  const invalidAuthorization =
    "The GitHub authorization expired or is not valid."

  const proof = await consumeProof(c.req.query("state") ?? "")
  if (!proof) return toConnectors(undefined, invalidAuthorization)

  // Only the session cookie: an API key or a bearer token cannot finish it.
  const headers = new Headers({ cookie: c.req.header("cookie") ?? "" })
  const session = await getAuth().api.getSession({ headers })
  if (session?.user.id !== proof.userId)
    return toConnectors(proof.orgSlug, invalidAuthorization)

  const code = c.req.query("code")
  if (!code) {
    return toConnectors(
      proof.orgSlug,
      "GitHub authorization was not completed.",
    )
  }
  if (!(await hasOrgAdminOrOwnerRole({ headers, orgId: proof.orgId }))) {
    return toConnectors(
      proof.orgSlug,
      "Only an organization admin or owner can connect GitHub.",
    )
  }
  if (proof.connectionId) {
    // The token proves access through the deployment's App only.
    const row = await getGithubConnectionRow(proof.orgId, proof.connectionId)
    if (!row || githubRowHasOwnApp(row, env))
      return toConnectors(proof.orgSlug, "Unknown GitHub connection.")
  }

  const token = await exchangeCode({
    env,
    code,
    codeVerifier: proof.codeVerifier,
  })
  if (!token) return toConnectors(proof.orgSlug, invalidAuthorization)
  const notAccessible =
    "Your GitHub account cannot access this GitHub App installation."
  let githubLogin: string
  try {
    if (!(await userCanAccessInstallation(token, proof.installationId)))
      return toConnectors(proof.orgSlug, notAccessible)
    githubLogin = (
      await new Octokit({ auth: token }).rest.users.getAuthenticated()
    ).data.login
  } catch {
    return toConnectors(proof.orgSlug, notAccessible)
  } finally {
    await revokeToken(env, token)
  }

  let installation: Awaited<ReturnType<typeof attachGithubInstallation>>
  try {
    installation = await attachGithubInstallation({
      orgId: proof.orgId,
      installationId: proof.installationId,
      connectionId: proof.connectionId,
      env,
    })
  } catch (e) {
    getLogger().error(e instanceof Error ? e : new Error(String(e)), {
      step: "github_installation.proof_attach",
    })
    return toConnectors(
      proof.orgSlug,
      "ctxpipe could not attach the installation. Try again.",
    )
  }
  if (!installation)
    return toConnectors(proof.orgSlug, "Unknown GitHub connection.")
  // The audit record of the proof. The token is not in it.
  getLogger().info("github_installation.proof", {
    userId: proof.userId,
    orgId: proof.orgId,
    githubLogin,
    installationId: proof.installationId,
    connectionId: installation.id,
  })
  return c.redirect(
    new URL(
      `/${encodeURIComponent(proof.orgSlug)}/github/setup`,
      env.AUTH_BASE_URL,
    ).toString(),
    302,
  )
}
