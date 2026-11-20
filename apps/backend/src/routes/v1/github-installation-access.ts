import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"

import { and, eq, gt } from "drizzle-orm"
import type { Context } from "hono"
import { Octokit } from "octokit"
import { z } from "zod"

import type { AppEnv } from "../../app/env.js"
import { getAuth } from "../../auth/config.js"
import { hasOrgAdminOrOwnerRole } from "../../auth/withAuth.js"
import type { Env } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { verifications } from "../../db/schema/auth.js"
import { rebindUnboundWorkspaces } from "../../domain/workspaces/workspace-lifecycle.js"
import { generateObjectId } from "../../lib/id.js"
import type { GitHubInstallationShape } from "../../models/connection-rows.js"
import { githubRowHasOwnApp } from "../../models/connection-rows.js"
import {
  getGithubConnectionRow,
  refreshGithubConnectionAccountSlug,
  registerInstallationOnConnection,
  upsertInstallation,
  userCanAccessInstallation,
} from "../../models/github-installation.js"
import { getLogger } from "../../observability/logger.js"

/**
 * Proof of installation access without a login link (CTX-1429). The acting
 * org admin authorizes the deployment's GitHub App once. The callback
 * exchanges the code for a short-lived user token, checks that the token can
 * see the installation, attaches it, and drops the token. Nothing stores the
 * token, and no account link is made or changed.
 *
 * The callback uses the redirect URI of GitHub sign-in, because that is the
 * callback URL that the App lists. The `state` prefix tells the two flows
 * apart.
 */
const STATE_PREFIX = "gh-installation."

const ProofStateSchema = z.object({
  nonce: z.string().min(1),
  exp: z.number().int().positive(),
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  userId: z.string().min(1),
  installationId: z.number().int().positive(),
  connectionId: z.string().min(1).optional(),
})

type ProofState = z.infer<typeof ProofStateSchema>

/** The redirect URI of GitHub sign-in in `auth/config.ts`. */
function githubOAuthRedirectUri(env: Env) {
  return `${env.AUTH_BASE_URL}/.auth/api/v1/auth/callback/github`
}

function sign(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`${STATE_PREFIX}${encodedPayload}`)
    .digest("base64url")
}

function verificationIdentifier(nonce: string) {
  return `github-installation-proof:${nonce}`
}

/**
 * The GitHub authorize URL for one proof, or `undefined` when the deployment
 * has no GitHub App client. The state is signed, short-lived, bound to the org,
 * the user and the installation, and single use: its nonce row holds the PKCE
 * verifier, and the callback deletes that row.
 */
export async function createGithubInstallationProofUrl(input: {
  env: Env
  orgId: string
  orgSlug: string
  userId: string
  installationId: number
  connectionId?: string
}): Promise<string | undefined> {
  const { env } = input
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return undefined
  const nonce = randomBytes(16).toString("base64url")
  const codeVerifier = randomBytes(32).toString("base64url")
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
  await getSystemDb()
    .insert(verifications)
    .values({
      id: generateObjectId("ver"),
      identifier: verificationIdentifier(nonce),
      value: codeVerifier,
      expiresAt,
    })
  const payload: ProofState = {
    nonce,
    exp: expiresAt.getTime(),
    orgId: input.orgId,
    orgSlug: input.orgSlug,
    userId: input.userId,
    installationId: input.installationId,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const url = new URL("https://github.com/login/oauth/authorize")
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID)
  url.searchParams.set("redirect_uri", githubOAuthRedirectUri(env))
  url.searchParams.set(
    "state",
    `${STATE_PREFIX}${encoded}.${sign(encoded, env.AUTH_SECRET)}`,
  )
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

function verifyState(state: string, secret: string): ProofState | undefined {
  const [encoded, signature, extra] = state
    .slice(STATE_PREFIX.length)
    .split(".")
  if (!encoded || !signature || extra !== undefined) return undefined
  const expected = Buffer.from(sign(encoded, secret))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return undefined
  try {
    const parsed = ProofStateSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    )
    return parsed.exp > Date.now() ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Deletes the nonce row, so a second use of the same state finds nothing. */
async function consumeCodeVerifier(nonce: string) {
  const [row] = await getSystemDb()
    .delete(verifications)
    .where(
      and(
        eq(verifications.identifier, verificationIdentifier(nonce)),
        gt(verifications.expiresAt, new Date()),
      ),
    )
    .returning({ value: verifications.value })
  return row?.value
}

async function exchangeCode(input: {
  env: Env
  code: string
  codeVerifier: string
}): Promise<string | undefined> {
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
      redirect_uri: githubOAuthRedirectUri(input.env),
      code_verifier: input.codeVerifier,
    }),
  })
  if (!res.ok) return undefined
  const body = (await res.json()) as { access_token?: unknown }
  return typeof body.access_token === "string" && body.access_token
    ? body.access_token
    : undefined
}

/**
 * The GitHub callback for a state from {@link createGithubInstallationProofUrl}.
 * It needs the browser session of the user who started the flow, so a link
 * that another person opens does nothing.
 */
export async function githubInstallationProofCallback(c: Context<AppEnv>) {
  const env = c.var.env
  const log = getLogger()
  const toConnectors = (orgSlug: string | undefined, description: string) => {
    const url = new URL(
      orgSlug ? `/${encodeURIComponent(orgSlug)}/connectors` : "/",
      env.AUTH_BASE_URL,
    )
    url.searchParams.set("error", "github_installation_proof_failed")
    url.searchParams.set("error_description", description)
    return c.redirect(url.toString(), 302)
  }
  const restart = "The GitHub authorization expired or is not valid."

  const state = verifyState(c.req.query("state") ?? "", env.AUTH_SECRET)
  if (!state) return toConnectors(undefined, restart)

  // Only the session cookie: an API key or a bearer token cannot finish it.
  const headers = new Headers({ cookie: c.req.header("cookie") ?? "" })
  const session = await getAuth().api.getSession({ headers })
  if (session?.user.id !== state.userId)
    return toConnectors(state.orgSlug, restart)

  const codeVerifier = await consumeCodeVerifier(state.nonce)
  if (!codeVerifier) return toConnectors(state.orgSlug, restart)

  const code = c.req.query("code")
  if (!code) {
    return toConnectors(
      state.orgSlug,
      "GitHub authorization was not completed.",
    )
  }
  if (!(await hasOrgAdminOrOwnerRole({ headers, orgId: state.orgId }))) {
    return toConnectors(
      state.orgSlug,
      "Only an organization admin or owner can connect GitHub.",
    )
  }
  if (state.connectionId) {
    // The token proves access through the deployment's App only.
    const row = await getGithubConnectionRow(state.orgId, state.connectionId)
    if (!row || githubRowHasOwnApp(row, env))
      return toConnectors(state.orgSlug, "Unknown GitHub connection.")
  }

  const token = await exchangeCode({ env, code, codeVerifier })
  if (!token) return toConnectors(state.orgSlug, restart)
  const notAccessible =
    "Your GitHub account cannot access this GitHub App installation."
  let githubLogin: string
  try {
    if (!(await userCanAccessInstallation(token, state.installationId)))
      return toConnectors(state.orgSlug, notAccessible)
    githubLogin = (
      await new Octokit({ auth: token }).rest.users.getAuthenticated()
    ).data.login
  } catch {
    return toConnectors(state.orgSlug, notAccessible)
  }

  const installation = await attachGithubInstallation({
    orgId: state.orgId,
    installationId: state.installationId,
    connectionId: state.connectionId,
    env,
    log,
  })
  if (!installation)
    return toConnectors(state.orgSlug, "Unknown GitHub connection.")
  // The audit record of the proof. The token is not in it.
  log.info("github_installation.proof", {
    userId: state.userId,
    orgId: state.orgId,
    githubLogin,
    installationId: state.installationId,
    connectionId: installation.id,
  })
  return c.redirect(
    new URL(
      `/${encodeURIComponent(state.orgSlug)}/github/setup`,
      env.AUTH_BASE_URL,
    ).toString(),
    302,
  )
}

/**
 * Attaches a proven installation to the org: to the named connection, else to
 * the org's connection for that installation. `undefined` when the named
 * connection is gone.
 */
export async function attachGithubInstallation(input: {
  orgId: string
  installationId: number
  connectionId?: string
  env: Env
  log: { error: (err: Error) => void }
}): Promise<GitHubInstallationShape | undefined> {
  const { orgId, installationId, env } = input
  let installation: GitHubInstallationShape | undefined
  if (input.connectionId) {
    installation = await registerInstallationOnConnection({
      orgId,
      connectionId: input.connectionId,
      installationId,
      env,
    })
    if (!installation) return undefined
  } else {
    installation = await upsertInstallation(orgId, installationId, env)
    installation =
      (await refreshGithubConnectionAccountSlug(orgId, installation.id, env)) ??
      installation
  }
  await rebindUnboundWorkspaces({
    orgId,
    connectionId: installation.id,
    env,
    log: input.log,
  })
  return installation
}
