import { spawn } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { fileURLToPath } from "node:url"
import { eq } from "drizzle-orm"
import { HttpResponse, http, passthrough } from "msw"
import { setupServer } from "msw/node"
import { expect, it } from "vitest"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import {
  workspaceLinkedRepositories,
  workspaceSandboxInstances,
  workspaces,
} from "../../db/schema/workspaces.js"
import { invalidateGithubAppCacheForConnection } from "../../models/github-installation.js"
import { sandboxGitTokenStore } from "../../models/sandbox-git-tokens.js"
import { withNativeChatFixture } from "../../test/native-chat-fixture.js"
import { revokeRunGitTokens } from "./run-git-tokens.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import { warmTanstackWorkspaceChat } from "./tanstack-workspace-chat.js"
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
  "brokers recorded read credentials through the fixed Git helper under one native run lease, and the run end revokes them",
  { timeout: 60_000 },
  async () => {
    const previous = {
      GITHUB_APP_ID: process.env.GITHUB_APP_ID,
      GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY,
    }
    const requests: Array<Record<string, unknown>> = []
    const revoked: string[] = []
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
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
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
      http.delete(
        "https://api.github.com/installation/token",
        ({ request }) => {
          revoked.push(request.headers.get("authorization") ?? "")
          return new HttpResponse(null, { status: 204 })
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
              orgSlug: f.orgSlug,
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
            // The run's recorded token is reused, not minted again.
            const second = await readCredential(env)
            expect(second).toEqual(first)
            expect(requests).toHaveLength(1)
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
            expect(requests).toHaveLength(1)
            // A new linked repository changes the scope, so a new token is
            // minted; the link is removed while GitHub mints it.
            await withOrgDbContext(f.orgId, async (db) => {
              await db.insert(repositories).values({
                id: `repo_third_${f.orgId}`,
                orgId: f.orgId,
                name: "third",
                gitUrl: "https://github.com/fixture/third.git",
                githubConnectionId: connectionId,
              })
              await db.insert(workspaceLinkedRepositories).values({
                id: `link_third_${f.orgId}`,
                orgId: f.orgId,
                workspaceId: f.workspaceId,
                gitUrl: "https://github.com/fixture/third.git",
              })
            })
            duringMint = async () => {
              await withOrgDbContext(f.orgId, (db) =>
                db
                  .delete(workspaceLinkedRepositories)
                  .where(
                    eq(workspaceLinkedRepositories.id, `link_third_${f.orgId}`),
                  ),
              )
            }
            const unlinked = await readCredential(env)
            expect(unlinked.code).toBe(1)
            expect(unlinked.stdout).toBe("")
            expect(requests).toHaveLength(2)
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
            expect(requests).toHaveLength(2)
            // A hosted sandbox never gets a token, even with a capability.
            await withOrgDbContext(f.orgId, (db) =>
              db.insert(workspaceSandboxInstances).values({
                id: `sandbox_vercel_${f.orgId}`,
                kind: "chat",
                orgId: f.orgId,
                workspaceId: f.workspaceId,
                conversationId: f.conversationId,
                provider: "vercel",
                lastHeartbeatAt: new Date(),
              }),
            )
            const hosted = await readCredential(env)
            expect(hosted.code).toBe(1)
            expect(hosted.stdout).toBe("")
            expect(requests).toHaveLength(2)
            await withOrgDbContext(f.orgId, (db) =>
              db
                .delete(workspaceSandboxInstances)
                .where(eq(workspaceSandboxInstances.orgId, f.orgId)),
            )
            // Every minted token is recorded under this run, also the one
            // the scope change kept from the agent; the run end revokes them.
            const tokens = sandboxGitTokenStore(f.orgId, parseEnv(process.env))
            const prefix = `run:${f.conversationId}:git:${owner}:`
            expect(
              (await tokens.list(prefix)).map((row) => row.token).sort(),
            ).toEqual(["fixture-read-1", "fixture-read-2"])
            expect(
              await revokeRunGitTokens({
                orgId: f.orgId,
                conversationId: f.conversationId,
                prefixes: [`git:${owner}:`],
              }),
            ).toBe(0)
            expect(revoked.sort()).toEqual([
              "token fixture-read-1",
              "token fixture-read-2",
            ])
            expect(await tokens.list(prefix)).toEqual([])
          })
          expect(expiredEnv).toBeDefined()
          const expired = await readCredential(expiredEnv ?? {})
          expect(expired.code).toBe(1)
          expect(expired.stdout).toBe("")
          expect(requests).toHaveLength(2)
          // A Files read (putFile, getDiff) prepares the sandbox with its own
          // clone token; the prepare revokes it when it returns.
          revoked.length = 0
          await warmTanstackWorkspaceChat({
            conversationId: f.conversationId,
            orgId: f.orgId,
            orgSlug: f.orgSlug,
            workspaceId: f.workspaceId,
            desiredUrl: revision.remote.url,
            desiredSha: f.sha,
            defaultBranch: "main",
            githubConnectionId: connectionId,
            writeStatus: "read_only",
            prompt: "prepare",
          })
          expect(requests).toHaveLength(3)
          expect(revoked).toEqual(["token fixture-read-3"])
          expect(
            await sandboxGitTokenStore(f.orgId, parseEnv(process.env)).list(
              `run:${f.conversationId}:`,
            ),
          ).toEqual([])
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
