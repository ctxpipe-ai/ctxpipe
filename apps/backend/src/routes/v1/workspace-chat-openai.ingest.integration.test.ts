import { createHmac, randomUUID } from "node:crypto"
import { OpenAPIHono } from "@hono/zod-openapi"
import { SpanKind } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { useMswServer } from "../../../test/msw.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { conversations } from "../../db/schema/conversations.js"
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  INGESTION_V2_WORKFLOW_NAME,
  type IngestionV2RunInput,
} from "../../domain/ingestion/ingestion-run.js"
import { ingestSandboxThreadId } from "../../domain/workspaces/chat-lifecycle.js"
import {
  mintWorkspaceChatRunCapability,
  mintWorkspaceIngestRunCapability,
  mintWorkspaceIngestToolsCapability,
  verifyWorkspaceChatRunCapability,
  verifyWorkspaceIngestRunCapability,
  verifyWorkspaceIngestToolsCapability,
} from "../../domain/workspaces/workspace-chat-run-capability.js"
import { generateObjectId } from "../../lib/id.js"
import { backendOtelMiddleware } from "../../observability/http.js"
import { LangfuseContextSpanProcessor } from "../../observability/langfuseContextProcessor.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { workspaceChatOpenaiRoutes } from "./workspace-chat-openai.js"

const AUTH_SECRET = "abcdefghijklmnopqrstuvwxyz123456"
const exporter = new InMemorySpanExporter()
const tracer = new NodeTracerProvider({
  spanProcessors: [
    new LangfuseContextSpanProcessor(),
    new SimpleSpanProcessor(exporter),
  ],
})
const MODEL_PROVIDER_URL = "http://model-provider.test/v1"

function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for ingest capabilities")
  return url
}

const server = useMswServer(
  http.post(`${MODEL_PROVIDER_URL}/chat/completions`, () =>
    HttpResponse.json({
      id: "chatcmpl_ingest",
      choices: [{ message: { role: "assistant", content: "ok" } }],
    }),
  ),
)

function app(): OpenAPIHono<AppEnv> {
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/ctxpipe_test",
    GRAPH_DB_URI: "redis://localhost:6379",
    AUTH_BASE_URL: "https://backend.example.com",
    AUTH_SECRET,
    PORT: "3000",
    MODEL_PROVIDER: "openai-like",
    MODEL_PROVIDER_URL,
    MODEL_PROVIDER_API_KEY: "sk-upstream",
    MODEL_FAST_NAME: "test/model-fast",
  })
  const routes = new OpenAPIHono<AppEnv>().basePath(
    "/:orgSlug/api/v1/workspace-chat/openai",
  )
  routes.use(contextStorage())
  routes.use("*", backendOtelMiddleware())
  routes.use(withTestRequestLogger)
  routes.use("*", async (c, next) => {
    c.set("env", env)
    await next()
  })
  routes.route("/", workspaceChatOpenaiRoutes)
  return routes
}

async function complete(token: string): Promise<number> {
  const res = await app().request(
    "/acme/api/v1/workspace-chat/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    },
  )
  await res.text()
  return res.status
}

async function listModels(token: string): Promise<number> {
  const res = await app().request(
    "/acme/api/v1/workspace-chat/openai/v1/models",
    { headers: { authorization: `Bearer ${token}` } },
  )
  await res.text()
  return res.status
}

describe("workspace-ingest-model capability", () => {
  const orgId = generateObjectId("org")
  const otherOrgId = generateObjectId("org")
  const orgSlug = `ingest-${orgId.slice(-8)}`
  const workspaceId = generateObjectId("ws")
  const conversationId = generateObjectId("conv")
  const sha = "b".repeat(40)
  const repoUrl = `https://github.com/example-owner/${workspaceId}`
  const chatOwner = randomUUID()
  const revision = {
    workspaceId,
    generation: 1,
    remote: { url: repoUrl, connectionId: null },
    sha,
    defaultBranch: "main",
    access: "read" as const,
  }
  let backend: BackendPostgres

  async function startRun(runOrgId: string): Promise<string> {
    const run = await backend.createWorkflowRun({
      workflowName: INGESTION_V2_WORKFLOW_NAME,
      version: null,
      idempotencyKey: null,
      config: {},
      context: null,
      input: { orgId: runOrgId, shadow: true } satisfies IngestionV2RunInput,
      parentStepAttemptNamespaceId: null,
      parentStepAttemptId: null,
      // Never due: no worker claims it.
      availableAt: new Date(Date.now() + 365 * 24 * 60 * 60_000),
      deadlineAt: null,
    })
    return run.id
  }

  async function holdShard(
    runId: string,
    shard: number,
    owner: string = randomUUID(),
    expiresAt = new Date(Date.now() + 60_000),
  ): Promise<string> {
    const key = ingestSandboxThreadId(runId, shard)
    await withOrgDbContext(orgId, (db) =>
      db
        .insert(sandboxLocks)
        .values({ orgId, key, owner, expiresAt })
        .onConflictDoUpdate({
          target: [sandboxLocks.orgId, sandboxLocks.key],
          set: { owner, expiresAt },
        }),
    )
    return owner
  }

  beforeAll(async () => {
    tracer.register()
    initDb(databaseUrl())
    backend = await BackendPostgres.connect(databaseUrl(), {
      runMigrations: false,
      namespaceId: openWorkflowNamespaceId(),
    })
    await getSystemDb()
      .insert(organizations)
      .values([
        {
          id: orgId,
          name: "Ingest capability org",
          slug: orgSlug,
          createdAt: new Date(),
        },
        {
          id: otherOrgId,
          name: "Other ingest capability org",
          slug: `other-${otherOrgId.slice(-8)}`,
          createdAt: new Date(),
        },
      ])
    await withOrgDbContext(orgId, async (db) => {
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId,
        slug: `ws-${workspaceId.slice(-8)}`,
        displayName: "Ingest capability workspace",
        workspaceRepositoryUrl: repoUrl,
        desiredGeneration: 1,
        desiredSha: sha,
        desiredDefaultBranch: "main",
      })
      await db.insert(conversations).values({
        id: conversationId,
        orgId,
        workspaceId,
        name: "Ingest capability conversation",
        source: "ui",
      })
      await db.insert(sandboxLocks).values({
        orgId,
        key: `chat-thread:${conversationId}`,
        owner: chatOwner,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      })
    })
  })

  afterAll(async () => {
    await withOrgDbContext(orgId, async (db) => {
      await db.delete(sandboxLocks).where(eq(sandboxLocks.orgId, orgId))
      await db.delete(conversations).where(eq(conversations.orgId, orgId))
      await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
    })
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, otherOrgId))
    await backend.stop()
    await closeDb()
    await tracer.shutdown()
  })

  it.each([
    429,
    502,
    "unreachable",
  ] as const)("ends the ingestion generation on upstream %s", async (status) => {
    const runId = await startRun(orgId)
    const lockOwner = await holdShard(runId, 0)
    const capability = await mintWorkspaceIngestRunCapability({
      authSecret: AUTH_SECRET,
      orgId,
      orgSlug,
      runId,
      shard: 0,
      step: "skill:root:docs",
      lockOwner,
    })
    server.use(
      http.post(`${MODEL_PROVIDER_URL}/chat/completions`, () =>
        status === "unreachable"
          ? HttpResponse.error()
          : HttpResponse.json({ error: "fixture failure" }, { status }),
      ),
    )
    exporter.reset()
    expect(await complete(capability)).toBe(
      status === "unreachable" ? 502 : status,
    )
    const calls = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "ingestion.model_call")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.attributes["http.response.status_code"]).toBe(
      status === "unreachable" ? 502 : status,
    )
    expect(calls[0]?.status.code).toBe(2)
  })

  it("calls the model proxy while the step holds the shard lock of an unfinished run", async () => {
    const runId = await startRun(orgId)
    const lockOwner = await holdShard(runId, 0)
    const capability = await mintWorkspaceIngestRunCapability({
      authSecret: AUTH_SECRET,
      orgId,
      orgSlug,
      runId,
      shard: 0,
      step: "skill:root:docs",
      lockOwner,
    })
    expect(
      await verifyWorkspaceIngestRunCapability({
        authSecret: AUTH_SECRET,
        token: capability,
      }),
    ).toMatchObject({
      purpose: "workspace-ingest-model",
      orgId,
      runId,
      shard: 0,
      step: "skill:root:docs",
      lockOwner,
    })
    expect(await listModels(capability)).toBe(200)
    exporter.reset()
    expect(await complete(capability)).toBe(200)
    // Attributed to the run, the shard, and the step; never to a conversation.
    const span = exporter
      .getFinishedSpans()
      .find((item) => item.kind === SpanKind.SERVER)
    expect(span?.attributes).toMatchObject({
      "ctxpipe.org.id": orgId,
      "ctxpipe.ingest.run.id": runId,
      "ctxpipe.ingest.shard": "0",
      "ctxpipe.ingest.step": "skill:root:docs",
    })
    expect(span?.attributes["ctxpipe.conversation.id"]).toBeUndefined()
    // The model call is a generation in the Langfuse session of the run.
    const call = exporter
      .getFinishedSpans()
      .find((item) => item.name === "ingestion.model_call")
    expect(call?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "ctxpipe.ingest.run.id": runId,
      "ctxpipe.ingest.shard": "0",
      "ctxpipe.ingest.step": "skill:root:docs",
      "session.id": `ingest:${runId}`,
    })
  })

  it("does not accept a chat capability as ingest, nor an ingest capability as chat", async () => {
    const runId = await startRun(orgId)
    const lockOwner = await holdShard(runId, 0)
    const ingest = await mintWorkspaceIngestRunCapability({
      authSecret: AUTH_SECRET,
      orgId,
      orgSlug,
      runId,
      shard: 0,
      step: "skill:root:docs",
      lockOwner,
    })
    const chat = await mintWorkspaceChatRunCapability({
      authSecret: AUTH_SECRET,
      orgId,
      orgSlug,
      conversationId,
      expectedOwner: chatOwner,
      revision,
      purpose: "workspace-chat-model",
    })
    expect(
      await verifyWorkspaceIngestRunCapability({
        authSecret: AUTH_SECRET,
        token: chat,
      }),
    ).toBeUndefined()
    expect(
      await verifyWorkspaceChatRunCapability({
        authSecret: AUTH_SECRET,
        token: ingest,
        purpose: "workspace-chat-model",
      }),
    ).toBeUndefined()
    // The chat capability still works as chat.
    expect(await complete(chat)).toBe(200)
  })

  it("refuses the capability after the step lets the shard lock go, when the lock expires, and with another shard", async () => {
    const runId = await startRun(orgId)
    const lockOwner = await holdShard(runId, 1)
    const capability = await mintWorkspaceIngestRunCapability({
      authSecret: AUTH_SECRET,
      orgId,
      orgSlug,
      runId,
      shard: 1,
      step: "skill:root:docs",
      lockOwner,
    })
    expect(await complete(capability)).toBe(200)

    // The next step takes the lock: the earlier step's capability ends.
    await holdShard(runId, 1)
    expect(await complete(capability)).toBe(401)
    expect(await listModels(capability)).toBe(401)

    // An expired lock of the same owner does not count.
    await holdShard(runId, 1, lockOwner, new Date(Date.now() - 1_000))
    expect(await complete(capability)).toBe(401)

    // A lock on another shard of the run does not count.
    await holdShard(runId, 2, lockOwner)
    expect(await complete(capability)).toBe(401)
  })

  it("refuses the capability after the run is cancelled", async () => {
    const runId = await startRun(orgId)
    const lockOwner = await holdShard(runId, 0)
    const capability = await mintWorkspaceIngestRunCapability({
      authSecret: AUTH_SECRET,
      orgId,
      orgSlug,
      runId,
      shard: 0,
      step: "skill:root:docs",
      lockOwner,
    })
    expect(await complete(capability)).toBe(200)
    await backend.cancelWorkflowRun({ workflowRunId: runId })
    expect(await complete(capability)).toBe(401)
  })

  it("does not mint for a lock it does not hold, for another org's run, or for an unknown run", async () => {
    const runId = await startRun(orgId)
    await holdShard(runId, 0)
    await expect(
      mintWorkspaceIngestRunCapability({
        authSecret: AUTH_SECRET,
        orgId,
        orgSlug,
        runId,
        shard: 0,
        step: "skill:root:docs",
        lockOwner: randomUUID(),
      }),
    ).rejects.toThrow("The ingest shard lock or run is not valid")

    const foreignRun = await startRun(otherOrgId)
    const foreignOwner = await holdShard(foreignRun, 0)
    await expect(
      mintWorkspaceIngestRunCapability({
        authSecret: AUTH_SECRET,
        orgId,
        orgSlug,
        runId: foreignRun,
        shard: 0,
        step: "skill:root:docs",
        lockOwner: foreignOwner,
      }),
    ).rejects.toThrow("The ingest shard lock or run is not valid")

    const unknownOwner = await holdShard("run_unknown", 0)
    await expect(
      mintWorkspaceIngestRunCapability({
        authSecret: AUTH_SECRET,
        orgId,
        orgSlug,
        runId: "run_unknown",
        shard: 0,
        step: "skill:root:docs",
        lockOwner: unknownOwner,
      }),
    ).rejects.toThrow("The ingest shard lock or run is not valid")
  })

  it("refuses a capability with a changed payload or another signing secret", async () => {
    const runId = await startRun(orgId)
    const lockOwner = await holdShard(runId, 0)
    const capability = await mintWorkspaceIngestRunCapability({
      authSecret: AUTH_SECRET,
      orgId,
      orgSlug,
      runId,
      shard: 0,
      step: "skill:root:docs",
      lockOwner,
    })
    const [payload, signature] = capability.split(".")
    const claims = JSON.parse(
      Buffer.from(payload ?? "", "base64url").toString("utf8"),
    )
    const forged = `${Buffer.from(JSON.stringify({ ...claims, shard: 3 })).toString("base64url")}.${signature}`
    await holdShard(runId, 3, lockOwner)
    expect(await complete(forged)).toBe(401)
    expect(
      await verifyWorkspaceIngestRunCapability({
        authSecret: "another-secret-another-secret-123",
        token: capability,
      }),
    ).toBeUndefined()
  })

  /** `payload.signature`, signed with `key` (the raw secret, or a purpose key). */
  function signed(claims: object, key: string | Buffer): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
    return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`
  }
  const purposeKey = (purpose: string) =>
    createHmac("sha256", AUTH_SECRET)
      .update(`ctxpipe:capability:${purpose}`)
      .digest()
  const checkouts = [
    {
      repositoryId: "repo_source",
      checkoutKey: "checkout-source",
      sha: "c".repeat(40),
    },
  ]

  it("signs each purpose with its own key: valid claims signed for another purpose or with the raw secret fail", async () => {
    const runId = await startRun(orgId)
    const lockOwner = await holdShard(runId, 0)
    const model = {
      version: 1,
      purpose: "workspace-ingest-model",
      orgId,
      orgSlug,
      runId,
      shard: 0,
      step: "skill:root:docs",
      lockOwner,
    }
    const tools = { ...model, purpose: "workspace-ingest-tools", checkouts }
    const verifyModel = (token: string) =>
      verifyWorkspaceIngestRunCapability({ authSecret: AUTH_SECRET, token })
    const verifyTools = (token: string) =>
      verifyWorkspaceIngestToolsCapability({ authSecret: AUTH_SECRET, token })
    // The purpose's own key works.
    expect(
      await verifyModel(signed(model, purposeKey("workspace-ingest-model"))),
    ).toMatchObject({ runId })
    expect(
      await verifyTools(signed(tools, purposeKey("workspace-ingest-tools"))),
    ).toMatchObject({ runId, checkouts })
    // The raw secret (as codesearch JWTs use) and another purpose's key fail.
    expect(await verifyModel(signed(model, AUTH_SECRET))).toBeUndefined()
    expect(await verifyTools(signed(tools, AUTH_SECRET))).toBeUndefined()
    expect(
      await verifyModel(signed(model, purposeKey("workspace-ingest-tools"))),
    ).toBeUndefined()
    expect(
      await verifyTools(signed(tools, purposeKey("workspace-ingest-model"))),
    ).toBeUndefined()
    expect(
      await verifyTools(signed(tools, purposeKey("workspace-chat-model"))),
    ).toBeUndefined()
    // A chat capability signed with the raw secret fails too.
    const chat = {
      version: 1,
      purpose: "workspace-chat-model",
      orgId,
      orgSlug,
      conversationId,
      lockOwner: chatOwner,
      revision,
    }
    expect(
      await verifyWorkspaceChatRunCapability({
        authSecret: AUTH_SECRET,
        token: signed(chat, AUTH_SECRET),
        purpose: "workspace-chat-model",
      }),
    ).toBeUndefined()
    expect(
      await verifyWorkspaceChatRunCapability({
        authSecret: AUTH_SECRET,
        token: signed(chat, purposeKey("workspace-chat-model")),
        purpose: "workspace-chat-model",
      }),
    ).toMatchObject({ conversationId })
  })

  it("binds the tool-bridge capability to the shard lock, the run, and its checkouts", async () => {
    const runId = await startRun(orgId)
    const lockOwner = await holdShard(runId, 0)
    const tools = await mintWorkspaceIngestToolsCapability({
      authSecret: AUTH_SECRET,
      orgId,
      orgSlug,
      runId,
      shard: 0,
      step: "skill:root:docs",
      lockOwner,
      checkouts,
    })
    expect(
      await verifyWorkspaceIngestToolsCapability({
        authSecret: AUTH_SECRET,
        token: tools,
      }),
    ).toMatchObject({ purpose: "workspace-ingest-tools", runId, checkouts })
    // It is not a model capability: the model proxy refuses it.
    expect(
      await verifyWorkspaceIngestRunCapability({
        authSecret: AUTH_SECRET,
        token: tools,
      }),
    ).toBeUndefined()
    expect(await complete(tools)).toBe(401)
    // The next step takes the lock: the capability ends.
    await holdShard(runId, 0)
    expect(
      await verifyWorkspaceIngestToolsCapability({
        authSecret: AUTH_SECRET,
        token: tools,
      }),
    ).toBeUndefined()
    // No mint without the lock, nor without a checkout.
    await expect(
      mintWorkspaceIngestToolsCapability({
        authSecret: AUTH_SECRET,
        orgId,
        orgSlug,
        runId,
        shard: 0,
        step: "skill:root:docs",
        lockOwner,
        checkouts,
      }),
    ).rejects.toThrow("The ingest shard lock or run is not valid")
    const owner = await holdShard(runId, 0)
    await expect(
      mintWorkspaceIngestToolsCapability({
        authSecret: AUTH_SECRET,
        orgId,
        orgSlug,
        runId,
        shard: 0,
        step: "skill:root:docs",
        lockOwner: owner,
        checkouts: [],
      }),
    ).rejects.toThrow()
  })
})
