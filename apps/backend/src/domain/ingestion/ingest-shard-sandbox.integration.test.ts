import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { connections } from "../../db/schema/connections.js"
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"
import { generateObjectId } from "../../lib/id.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { workspaceChatOpenaiRoutes } from "../../routes/v1/workspace-chat-openai.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import {
  type GithubTokenLog,
  githubTokenHandlers,
  insertGithubConnection,
  stubGithubApp,
} from "../../test/ingest-github.js"
import { ingestSandboxThreadId } from "../workspaces/chat-lifecycle.js"
import { refreshIngestSandboxEgress } from "../workspaces/ingest-sandbox-egress.js"
import { postgresSandboxLocks } from "../workspaces/sandbox-lock-store.js"
import { ingestShardStepEgress } from "./ingest-shard-sandbox.js"
import { INGESTION_V2_WORKFLOW_NAME } from "./ingestion-run.js"

/*
 * The production shard runtime at its step seam (`withShard`): each step
 * holds the shard lock, mints its capabilities for that lock owner, and
 * gives them to the sandbox's vault (msw is Agent Vault). When a later step
 * holds the lock, the earlier step's capability gets 401 at the API.
 */

const AUTH_SECRET = "abcdefghijklmnopqrstuvwxyz123456"
const VAULT = "http://agent-vault.test"
const MODEL_PROVIDER_URL = "http://model-provider.test/v1"
const orgId = generateObjectId("org")
const orgSlug = `shard-${orgId.slice(-8)}`
const connectionId = generateObjectId("con")
const githubLog: GithubTokenLog = { minted: [], revoked: [] }
/** The credential bodies that the runtime gave the vault, in order. */
const vaultCredentials: string[] = []

const server = setupServer(
  ...githubTokenHandlers(githubLog, () => "fixture-only-github-token"),
  http.post(`${VAULT}/v1/auth/login`, () =>
    HttpResponse.json({ token: "owner-token" }),
  ),
  // The SDK sends credentials to `/v1/credentials` (vault in the body) and
  // services to `/v1/vaults/:name/services`.
  ...[`${VAULT}/v1/credentials`, `${VAULT}/v1/vaults/:name/*`].map((path) =>
    http.all(path, async ({ request }) => {
      if (request.method !== "GET") {
        const body = await request.text()
        if (body.length) vaultCredentials.push(body)
      }
      return HttpResponse.json({})
    }),
  ),
  http.post(`${MODEL_PROVIDER_URL}/chat/completions`, () =>
    HttpResponse.json({
      id: "chatcmpl_shard",
      choices: [{ message: { role: "assistant", content: "ok" } }],
    }),
  ),
)

function api(): OpenAPIHono<AppEnv> {
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/ctxpipe_test",
    AUTH_BASE_URL: "https://backend.example.com",
    AUTH_SECRET,
    MODEL_PROVIDER: "openai-like",
    MODEL_PROVIDER_URL,
    MODEL_PROVIDER_API_KEY: "sk-upstream",
    MODEL_FAST_NAME: "openai/gpt-5.6-terra",
  })
  const routes = new OpenAPIHono<AppEnv>().basePath(
    "/:orgSlug/api/v1/workspace-chat/openai",
  )
  routes.use(contextStorage())
  routes.use(withTestRequestLogger)
  routes.use("*", async (c, next) => {
    c.set("env", env)
    await next()
  })
  routes.route("/", workspaceChatOpenaiRoutes)
  return routes
}

async function complete(capability: string): Promise<number> {
  const res = await api().request(
    `/${orgSlug}/api/v1/workspace-chat/openai/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${capability}`,
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    },
  )
  await res.text()
  return res.status
}

let backend: BackendPostgres
let runId: string

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL is required for this test")
  initDb(databaseUrl)
  server.listen({ onUnhandledRequest: "error" })
  stubGithubApp()
  vi.stubEnv("AUTH_SECRET", AUTH_SECRET)
  vi.stubEnv("AUTH_BASE_URL", "https://backend.example.com")
  vi.stubEnv("SANDBOX_CALLBACK_HOST", "")
  vi.stubEnv("AGENT_VAULT_ADDR", VAULT)
  vi.stubEnv("AGENT_VAULT_OWNER_PASSWORD", "fixture-owner-password")
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgSlug,
    name: "Shard seam org",
    createdAt: new Date(),
  })
  await insertGithubConnection({
    orgId,
    id: connectionId,
    installationId: 555,
    accountSlug: "acme",
  })
  backend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
    namespaceId: openWorkflowNamespaceId(),
  })
  const run = await backend.createWorkflowRun({
    workflowName: INGESTION_V2_WORKFLOW_NAME,
    version: null,
    idempotencyKey: null,
    config: {},
    context: null,
    input: { orgId, shadow: true },
    parentStepAttemptNamespaceId: null,
    parentStepAttemptId: null,
    // Never due: no worker claims it.
    availableAt: new Date(Date.now() + 365 * 24 * 60 * 60_000),
    deadlineAt: null,
  })
  runId = run.id
})

afterAll(async () => {
  server.close()
  vi.unstubAllEnvs()
  await withOrgDbContext(orgId, async (db) => {
    await db.delete(sandboxLocks).where(eq(sandboxLocks.orgId, orgId))
    await db.delete(connections).where(eq(connections.orgId, orgId))
  })
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await backend?.stop()
  await closeDb()
})

describe("shard step egress", () => {
  it("mints a capability per lock owner, refreshes the vault per step, and ends the old owner's capability", async () => {
    const spec = {
      orgId,
      runId,
      shard: 0,
      // The egress does not read the bundle.
      bundle: { name: "ingest-0000000000000000", skills: [], files: [] },
      source: {
        url: "https://github.com/acme/checkout-api",
        githubConnectionId: connectionId,
        sha: "a".repeat(40),
        repositoryId: null,
      },
      destinations: [
        {
          workspaceId: "ws_seam",
          url: "https://github.com/acme/context",
          githubConnectionId: connectionId,
          generation: 1,
          pinnedRevision: "b".repeat(40),
          repositoryId: null,
          sourcePath: "sources/github/acme/checkout-api.md",
        },
      ],
    }
    // As `withShard` does for each step: the lock, the egress, the refresh.
    const step = (
      name: string,
      inLock: (capability: string) => Promise<void>,
    ) => {
      let owner = ""
      return postgresSandboxLocks(
        orgId,
        new AbortController(),
        undefined,
        (r) => {
          owner = r.owner
        },
      ).withLock(ingestSandboxThreadId(runId, 0), async () => {
        const egress = await ingestShardStepEgress({
          spec,
          lockOwner: owner,
          step: name,
        })
        expect(egress.modelProxyUrl).toBe(
          `https://backend.example.com/${orgSlug}/api/v1/workspace-chat/openai/v1`,
        )
        await refreshIngestSandboxEgress({ orgId, runId, shard: 0, egress })
        await inLock(egress.capability)
        return { owner, capability: egress.capability }
      })
    }

    const first = await step("skill:a~1:apis:ws_seam", async (capability) => {
      expect(await complete(capability)).toBe(200)
    })
    const sentFirst = vaultCredentials.length
    expect(vaultCredentials.join("\n")).toContain(first.capability)

    const second = await step("skill:b~2:apis:ws_seam", async (capability) => {
      // The earlier step's capability ends with its lock owner.
      expect(await complete(first.capability)).toBe(401)
      expect(await complete(capability)).toBe(200)
    })
    expect(second.owner).not.toBe(first.owner)
    expect(second.capability).not.toBe(first.capability)
    // The second step gave the vault its own capability.
    expect(vaultCredentials.slice(sentFirst).join("\n")).toContain(
      second.capability,
    )
    expect(vaultCredentials.slice(sentFirst).join("\n")).not.toContain(
      first.capability,
    )
  })
})
