import { parseEnv } from "../../config/env.js"
import { getRepoReadCloneToken } from "../../models/github-installation.js"
import {
  type SandboxGitTokenStore,
  sandboxGitTokenStore,
} from "../../models/sandbox-git-tokens.js"
import {
  type VercelCredentials,
  vercelCredentials,
} from "./vercel-sandbox-provider.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

/**
 * What a hosted (Vercel) sandbox for a Workspace needs: credentials, the
 * environment it is tagged with, the backend origin it may reach, and fresh
 * GitHub read tokens for its firewall rule. Fails closed: without Vercel
 * credentials, a GitHub Workspace repository, or (on Railway) the
 * environment name there is no hosted sandbox.
 */
export async function hostedSandboxAccess(input: {
  orgId: string
  githubConnectionId?: string | null
  desiredUrl: string
}): Promise<
  | {
      ok: true
      credentials: VercelCredentials
      environment: string
      publicBaseUrl: string
      backendHost: string
      tokens: SandboxGitTokenStore
      mintGitToken: () => Promise<string>
    }
  | { ok: false; status: 503; error: string }
> {
  const unavailable = (error: string) => ({
    ok: false as const,
    status: 503 as const,
    error,
  })
  const credentials = await vercelCredentials().catch(() => null)
  if (!credentials)
    return unavailable("Hosted chat sandboxes are not configured")
  // On Railway, an untagged sandbox would escape the PR-close cleanup.
  const environment = process.env.RAILWAY_ENVIRONMENT_NAME?.trim()
  if (!environment && process.env.RAILWAY_PROJECT_ID?.trim())
    return unavailable("Hosted chat needs the Railway environment name")
  const repoFullName = githubRepoFullNameFromWorkspaceUrl(input.desiredUrl)
  if (!repoFullName)
    return unavailable("Hosted chat needs a GitHub Workspace repository")
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const publicBaseUrl = new URL(env.AUTH_BASE_URL).origin
  return {
    ok: true,
    credentials,
    environment: environment || "local",
    publicBaseUrl,
    backendHost: new URL(publicBaseUrl).hostname,
    tokens: sandboxGitTokenStore(input.orgId, env),
    mintGitToken: async () => {
      const token = await getRepoReadCloneToken(input.orgId, env, {
        githubConnectionId: input.githubConnectionId ?? undefined,
        repoFullName,
        fresh: true,
      })
      if (!token) throw new Error("Workspace GitHub read access is unavailable")
      return token
    },
  }
}
