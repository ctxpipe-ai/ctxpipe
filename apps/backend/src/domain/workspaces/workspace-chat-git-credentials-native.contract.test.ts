import { spawn } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { fileURLToPath } from "node:url"
import { eq } from "drizzle-orm"
import { HttpResponse, http, passthrough } from "msw"
import { setupServer } from "msw/node"
import { expect, it } from "vitest"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import {
  workspaceLinkedRepositories,
  workspaces,
} from "../../db/schema/workspaces.js"
import { invalidateGithubAppCacheForConnection } from "../../models/github-installation.js"
import { withNativeChatFixture } from "../../test/native-chat-fixture.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import { mintWorkspaceChatRunCapability } from "./workspace-chat-run-capability.js"

const helper = fileURLToPath(
  new URL(
    "../../../../../scripts/chat-sandbox/git-credential.mjs",
    import.meta.url,
  ),
)

async function readCredential(
  env: NodeJS.ProcessEnv,
  repository = "fixture/workspace.git",
) {
  const child = spawn(process.execPath, [helper, "get"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (data) => {
    stdout += data
  })
  child.stderr.setEncoding("utf8").on("data", (data) => {
    stderr += data
  })
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  child.stdin.end(`protocol=https\nhost=github.com\npath=${repository}\n\n`)
  return { code: await closed, stdout, stderr }
}

it(
  "renews brokered read credentials through the fixed Git helper under one native run lease",
  { timeout: 60_000 },
  async () => {
    const previous = {
      GITHUB_APP_ID: process.env.GITHUB_APP_ID,
      GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY,
    }
    const requests: Array<Record<string, unknown>> = []
    let duringMint: (() => Promise<void>) | undefined
    const github = setupServer(
      http.post(
        "https://api.github.com/app/installations/123456789/access_tokens",
        async ({ request }) => {
          requests.push((await request.json()) as Record<string, unknown>)
          await duringMint?.()
          return HttpResponse.json(
            {
              token: `fixture-read-${requests.length}`,
              // Accelerated external token lifetime: the auth client's normal cache
              // expiry must cause renewal, without fake clocks or cache resets.
              expires_at: new Date(
                Date.now() + (requests.length === 1 ? 62_000 : 3_600_000),
              ).toISOString(),
              permissions: {
                contents: "read",
                issues: "read",
                pull_requests: "read",
                metadata: "read",
              },
            },
            { status: 201 },
          )
        },
      ),
      http.all(/http:\/\/127\.0\.0\.1(?::\d+)?\//, () => passthrough()),
    )
    github.listen({ onUnhandledRequest: "error" })
    process.env.GITHUB_APP_ID = "12345"
    process.env.GITHUB_PRIVATE_KEY = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey
    try {
      await withNativeChatFixture(async (f) => {
        const connectionId = `con_${f.orgId}`
        const otherConnection = `con_other_${f.orgId}`
        const revision = {
          workspaceId: f.workspaceId,
          generation: 1,
          remote: {
            url: "https://github.com/fixture/workspace.git",
            connectionId,
          },
          defaultBranch: "main",
          sha: f.sha,
          access: "read" as const,
        }
        await withOrgDbContext(f.orgId, async (db) => {
          await db.insert(connections).values(
            [connectionId, otherConnection].map((id) => ({
              id,
              orgId: f.orgId,
              type: "github" as const,
              config: {
                installationId: 123456789,
                accountSlug: "fixture",
                ingestAllRepositories: false,
                includeFutureRepos: false,
              },
            })),
          )
          await db
            .update(workspaces)
            .set({
              workspaceRepositoryUrl: revision.remote.url,
              githubConnectionId: connectionId,
              desiredDefaultBranch: "main",
            })
            .where(eq(workspaces.id, f.workspaceId))
          await db.insert(repositories).values([
            {
              id: `repo_link_${f.orgId}`,
              orgId: f.orgId,
              name: "linked",
              gitUrl: "https://github.com/fixture/linked.git",
              githubConnectionId: connectionId,
            },
            {
              id: `repo_other_${f.orgId}`,
              orgId: f.orgId,
              name: "other",
              gitUrl: "https://github.com/fixture/other.git",
              githubConnectionId: otherConnection,
            },
          ])
          await db.insert(workspaceLinkedRepositories).values(
            ["linked", "other"].map((name) => ({
              id: `link_${name}_${f.orgId}`,
              orgId: f.orgId,
              workspaceId: f.workspaceId,
              gitUrl: `https://github.com/fixture/${name}.git`,
            })),
          )
        })
        let expiredEnv: NodeJS.ProcessEnv | undefined
        try {
          let owner: string | undefined
          await postgresSandboxLocks(f.orgId, undefined, undefined, (lease) => {
            owner = lease.owner
          }).withLock(`chat-thread:${f.conversationId}`, async () => {
            if (!owner) throw new Error("Native owner missing")
            const capability = await mintWorkspaceChatRunCapability({
              expectedOwner: owner,
              authSecret: process.env.AUTH_SECRET ?? "",
              orgId: f.orgId,
              conversationId: f.conversationId,
              revision,
              purpose: "workspace-chat-git",
            })
            const env = {
              PATH: process.env.PATH,
              CTXPIPE_GIT_RUN_CAPABILITY: capability,
              CTXPIPE_MODEL_PROXY_URL: `http://127.0.0.1:${process.env.PORT}/${f.orgSlug}/api/v1/workspace-chat/openai/v1`,
            }
            expiredEnv = env
            const first = await readCredential(env)
            expect(first).toEqual({
              code: 0,
              stdout: "username=x-access-token\npassword=fixture-read-1\n\n",
              stderr: "",
            })
            await new Promise((resolve) => setTimeout(resolve, 2_100))
            const second = await readCredential(env)
            expect(second).toEqual({
              code: 0,
              stdout: "username=x-access-token\npassword=fixture-read-2\n\n",
              stderr: "",
            })
            expect(requests).toHaveLength(2)
            for (const request of requests)
              expect(request).toMatchObject({
                repositories: ["linked", "workspace"],
                permissions: {
                  contents: "read",
                  issues: "read",
                  pull_requests: "read",
                  metadata: "read",
                },
              })
            const denied = await readCredential(env, "fixture/other.git")
            expect(denied.code).toBe(1)
            expect(denied.stdout).toBe("")
            expect(requests).toHaveLength(2)
            duringMint = async () => {
              await withOrgDbContext(f.orgId, (db) =>
                db
                  .delete(workspaceLinkedRepositories)
                  .where(
                    eq(
                      workspaceLinkedRepositories.id,
                      `link_linked_${f.orgId}`,
                    ),
                  ),
              )
            }
            invalidateGithubAppCacheForConnection(connectionId)
            const unlinked = await readCredential(env)
            expect(unlinked.code).toBe(1)
            expect(unlinked.stdout).toBe("")
            expect(requests).toHaveLength(3)
            duringMint = undefined
            const extra = Array.from({ length: 500 }, (_, index) => ({
              id: `repo_cap_${index}_${f.orgId}`,
              orgId: f.orgId,
              name: `cap-${index}`,
              gitUrl: `https://github.com/fixture/cap-${index}.git`,
              githubConnectionId: connectionId,
            }))
            await withOrgDbContext(f.orgId, async (db) => {
              await db.insert(repositories).values(extra)
              await db.insert(workspaceLinkedRepositories).values(
                extra.map((repo) => ({
                  id: `link_${repo.id}`,
                  orgId: f.orgId,
                  workspaceId: f.workspaceId,
                  gitUrl: repo.gitUrl,
                })),
              )
            })
            const oversized = await readCredential(env)
            expect(oversized.code).toBe(1)
            expect(oversized.stdout).toBe("")
            expect(requests).toHaveLength(3)
          })
          expect(expiredEnv).toBeDefined()
          const expired = await readCredential(expiredEnv ?? {})
          expect(expired.code).toBe(1)
          expect(expired.stdout).toBe("")
          expect(requests).toHaveLength(3)
        } finally {
          invalidateGithubAppCacheForConnection(connectionId)
          await withOrgDbContext(f.orgId, async (db) => {
            await db
              .delete(workspaceLinkedRepositories)
              .where(eq(workspaceLinkedRepositories.orgId, f.orgId))
            await db.delete(repositories).where(eq(repositories.orgId, f.orgId))
            await db
              .update(workspaces)
              .set({ githubConnectionId: null })
              .where(eq(workspaces.id, f.workspaceId))
            await db.delete(connections).where(eq(connections.orgId, f.orgId))
          })
        }
      })
    } finally {
      github.close()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  },
)
