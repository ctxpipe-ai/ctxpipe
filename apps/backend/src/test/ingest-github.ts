import { generateKeyPairSync } from "node:crypto"

import { HttpResponse, http } from "msw"
import { vi } from "vitest"

import { withOrgDbContext } from "../db/client.js"
import { connections } from "../db/schema/connections.js"

/** What the GitHub stand-in saw: minted tokens and revoked tokens. */
export type GithubTokenLog = {
  minted: Array<{ installationId: number; repositories: string[] }>
  revoked: string[]
  /** When set, the permissions that each mint asks for, in order. */
  mintedPermissions?: Array<Record<string, string> | undefined>
}

/**
 * msw handlers for GitHub App installation tokens: a mint answers
 * `token(installationId)`, and a revoke records the token it got. The
 * installation answers with `installationPermissions(installationId)`. The
 * default is the App permissions of the self-host docs, with Issues.
 */
export function githubTokenHandlers(
  log: GithubTokenLog,
  token: (installationId: number) => string,
  installationPermissions: (
    installationId: number,
  ) => Record<string, string> = () => ({
    contents: "write",
    metadata: "read",
    pull_requests: "write",
    issues: "read",
  }),
) {
  return [
    http.get("https://api.github.com/app/installations/:id", ({ params }) =>
      HttpResponse.json({
        id: Number(params.id),
        permissions: installationPermissions(Number(params.id)),
      }),
    ),
    http.post(
      "https://api.github.com/app/installations/:id/access_tokens",
      async ({ request, params }) => {
        const installationId = Number(params.id)
        const body = (await request.json()) as {
          repositories?: string[]
          permissions?: Record<string, string>
        }
        log.minted.push({
          installationId,
          repositories: body.repositories ?? [],
        })
        log.mintedPermissions?.push(body.permissions)
        return HttpResponse.json(
          {
            token: token(installationId),
            expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
            permissions: { contents: "read", metadata: "read" },
          },
          { status: 201 },
        )
      },
    ),
    http.delete("https://api.github.com/installation/token", ({ request }) => {
      log.revoked.push(
        (request.headers.get("authorization") ?? "").replace(/^token /, ""),
      )
      return new HttpResponse(null, { status: 204 })
    }),
  ]
}

/** A GitHub App identity for minting (the key is made per run). */
export function stubGithubApp(): void {
  vi.stubEnv("GITHUB_APP_ID", "12345")
  vi.stubEnv(
    "GITHUB_PRIVATE_KEY",
    generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey,
  )
}

/** A GitHub connection row of the org, for one installation and account. */
export async function insertGithubConnection(input: {
  orgId: string
  id: string
  installationId: number
  accountSlug: string
}): Promise<void> {
  await withOrgDbContext(input.orgId, (db) =>
    db.insert(connections).values({
      id: input.id,
      orgId: input.orgId,
      type: "github",
      config: {
        installationId: input.installationId,
        accountSlug: input.accountSlug,
        ingestAllRepositories: false,
        includeFutureRepos: false,
      },
    }),
  )
}
