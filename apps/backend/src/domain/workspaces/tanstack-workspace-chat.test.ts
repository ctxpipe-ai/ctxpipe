import { initLogger } from "evlog"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  claimWorkspaceChatTurn,
  resetWorkspaceChatTurnClaims,
  workspaceChatTurnIsBusy,
} from "./workspace-chat-turn-claim.js"

const chatMock = vi.hoisted(() =>
  vi.fn(async function* (): AsyncGenerator<{
    type: string
    delta?: string
  }> {
    yield { type: "TEXT_MESSAGE_CONTENT", delta: "ok" }
  }),
)
const opencodeTextMock = vi.hoisted(() =>
  vi.fn((_model?: string, _opts?: { port?: number }) => "adapter"),
)
const defineSandboxMock = vi.hoisted(() => vi.fn((input) => input))
const defineWorkspaceMock = vi.hoisted(() => vi.fn((input) => input))
const gitSourceMock = vi.hoisted(() => vi.fn((input) => input))
const withSandboxMock = vi.hoisted(() =>
  vi.fn((def: unknown, _opts?: unknown) => def),
)
const dockerSandboxMock = vi.hoisted(() => vi.fn(() => "docker-provider"))
const sbxSandboxMock = vi.hoisted(() => vi.fn(() => "sbx-provider"))
const listSandboxInstancesMock = vi.hoisted(() =>
  vi.fn(
    async (): Promise<
      Array<{
        id: string
        kind: "chat" | "job"
        orgId: string
        workspaceId: string
        conversationId?: string
        provider?: string
        providerSandboxId?: string
        state: "live" | "destroy_failed"
        lastHeartbeatAt: Date
      }>
    > => [],
  ),
)

const toSseResponse = vi.hoisted(() => {
  return (stream: AsyncIterable<object>): Response => {
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of stream) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
              )
            }
            controller.close()
          } catch (error) {
            controller.error(error)
          }
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )
  }
})

vi.mock("@tanstack/ai", () => ({
  chat: chatMock,
  toServerSentEventsResponse: toSseResponse,
  toHttpResponse: toSseResponse,
}))
vi.mock("@tanstack/ai-opencode", () => ({ opencodeText: opencodeTextMock }))
const createSecretsMock = vi.hoisted(() =>
  vi.fn((values: Record<string, string>) => values),
)
const fileSkillMock = vi.hoisted(() =>
  vi.fn((input: { path: string; content: string }) => ({
    kind: "file",
    ...input,
  })),
)
const startWorkspaceChatModelProxyMock = vi.hoisted(() =>
  vi.fn(async (input?: { advertisedHost?: string }) => ({
    baseUrl: `http://${input?.advertisedHost ?? "127.0.0.1"}:18789`,
    close: vi.fn(async () => {}),
  })),
)

vi.mock("@tanstack/ai-sandbox", () => ({
  defineSandbox: defineSandboxMock,
  defineWorkspace: defineWorkspaceMock,
  gitSource: gitSourceMock,
  fileSkill: fileSkillMock,
  createSecrets: createSecretsMock,
  withSandbox: withSandboxMock,
}))
vi.mock("@tanstack/ai-sandbox-docker", () => ({
  dockerSandbox: dockerSandboxMock,
  sbxSandbox: sbxSandboxMock,
}))
vi.mock("@tanstack/ai-sandbox-local-process", () => ({
  localProcessSandbox: vi.fn(() => "local-provider"),
}))
vi.mock("./workspace-chat-model-proxy.js", () => ({
  startWorkspaceChatModelProxy: startWorkspaceChatModelProxyMock,
}))
const streamAttachedOpenCodeTurnMock = vi.hoisted(() =>
  vi.fn(async function* () {
    yield { type: "TEXT_MESSAGE_CONTENT", delta: "attached" }
    yield { type: "RUN_FINISHED" }
  }),
)
vi.mock("./workspace-chat-opencode-attach.js", () => ({
  streamAttachedOpenCodeTurn: streamAttachedOpenCodeTurnMock,
  startConversationOpenCodeServe: vi.fn(async () => null),
}))
const nameConversationIfUnnamedMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(null),
)
const orgTxDepth = vi.hoisted(() => ({ value: 0 }))
const embedInTx = vi.hoisted(() => ({ value: false, seen: false }))
const searchInTx = vi.hoisted(() => ({ value: false, seen: false }))

vi.mock("../../graphs/conversationGraph/nodes/conversationNaming.js", () => ({
  nameConversationIfUnnamed: nameConversationIfUnnamedMock,
}))

vi.mock("../../db/client.js", () => ({
  tryGetOrgDb: () => (orgTxDepth.value > 0 ? {} : undefined),
  tryGetOrgDbOrgId: () => (orgTxDepth.value > 0 ? "org_1" : undefined),
  assertNotInOrgDbContext: () => undefined,

  withOrgDbContext: async (_orgId: string, fn: () => unknown) => {
    orgTxDepth.value += 1
    try {
      return await fn()
    } finally {
      orgTxDepth.value -= 1
    }
  },
}))

vi.mock("../../auth/withAuth.js", () => ({
  withOrgIdContext: (_org: unknown, fn: () => unknown) => fn(),
}))

const loadTurnsMock = vi.hoisted(() =>
  vi.fn(
    async (): Promise<
      Array<{ role: "user" | "assistant"; content: string }>
    > => [],
  ),
)
const appendTurnMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock("../../models/conversation-messages.js", () => ({
  loadConversationTurns: loadTurnsMock,
  appendConversationTurn: appendTurnMock,
}))

const getWorkspaceById = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{
      id: string
      orgId: string
      workspaceRepositoryUrl: string
      activeProjectionUrl: string | null
      activeProjectionSha: string | null
    }> => ({
      id: "ws_1",
      orgId: "org_1",
      workspaceRepositoryUrl: "https://github.com/acme/docs",
      activeProjectionUrl: "https://github.com/acme/docs",
      activeProjectionSha: "abc",
    }),
  ),
)

const claimSandboxInstance = vi.hoisted(() =>
  vi.fn(
    async (input: {
      id: string
      kind?: string
      workspaceId?: string
      conversationId?: string
      provider?: string
      providerSandboxId?: string
      state?: string
      lastHeartbeatAt?: Date
    }) => ({
      record: input,
      inserted: true,
    }),
  ),
)

vi.mock("../../models/workspaces.js", () => ({
  persistSandboxInstance: vi.fn(async () => {}),
  deleteSandboxInstance: vi.fn(async () => {}),
  claimSandboxInstance,
  listSandboxInstances: listSandboxInstancesMock,
  heartbeatSandboxInstance: vi.fn(async () => {}),
  getSandboxInstance: vi.fn(async () => null),
  getWorkspaceById,
  listLinkedRepositories: vi.fn(async () => [
    { gitUrl: "https://github.com/acme/app" },
  ]),
  listWorkspaceKnowledgeUnits: vi.fn(async () => ({
    units: [
      {
        path: "knowledge/billing/ledger.md",
        servingId: "kn_1",
        body: "The billing ledger.",
        links: [],
        claims: [],
      },
    ],
    lastUpdatedAt: null,
  })),
  listWorkspaceKnowledgeUnitsForChat: vi.fn(async () => [
    {
      servingId: "kn_1",
      path: "knowledge/billing/ledger.md",
      body: "The billing ledger.",
      projectionSha: "abc",
      embedding: null,
      claims: [],
    },
  ]),
}))

vi.mock("../../models/repositories.js", () => ({
  findRepositoriesByNormalizedGitUrls: vi.fn(async () => [
    {
      id: "repo_aaaaaaaaaaaaaaaaaaaaaaaa",
      gitUrl: "https://github.com/acme/app",
    },
  ]),
}))

vi.mock("../../retrieval/index.js", () => ({
  hybridSearch: async () => {
    searchInTx.seen = true
    searchInTx.value = orgTxDepth.value > 0
    return [{ objectId: "kn_1" }]
  },
}))

vi.mock("../../retrieval/services/modelProvider.js", () => ({
  generateEmbedding: async () => {
    embedInTx.seen = true
    embedInTx.value = orgTxDepth.value > 0
    return [1, 0, 0]
  },
}))

import { getLogger } from "../../observability/logger.js"
import { withTestLogger } from "../../test/with-test-logger.js"
import {
  runTanstackWorkspaceChat as runTanstackWorkspaceChatHttp,
  type TanstackWorkspaceChatInput,
} from "./tanstack-workspace-chat.js"
import { parseSseDataLines } from "./workspace-chat-agui.js"
import {
  resetWorkspaceChatConversationRuntimes,
  setWorkspaceChatConversationRuntime,
} from "./workspace-chat-conversation-runtime.js"
import {
  clearWorkspaceChatOpenCodeSessionId,
  persistWorkspaceChatOpenCodeSessionId,
} from "./workspace-chat-opencode-session.js"

async function runTanstackWorkspaceChat(input: TanstackWorkspaceChatInput) {
  const res = await runTanstackWorkspaceChatHttp(input)
  const body = await res.text()
  return new Response(body, {
    status: res.status,
    headers: res.headers,
  })
}

describe("runTanstackWorkspaceChat", () => {
  beforeEach(() => {
    resetWorkspaceChatTurnClaims()
    resetWorkspaceChatConversationRuntimes()
    clearWorkspaceChatOpenCodeSessionId("conv_1")
    clearWorkspaceChatOpenCodeSessionId("conv_resume")
    vi.clearAllMocks()
    nameConversationIfUnnamedMock.mockResolvedValue(null)
    orgTxDepth.value = 0
    embedInTx.seen = false
    embedInTx.value = false
    searchInTx.seen = false
    searchInTx.value = false
    process.env.SANDBOX_PROVIDER = "docker"
    process.env.MODEL_PROVIDER = "openai-like"
    process.env.MODEL_PROVIDER_API_KEY = "sk-test-chat"
    delete process.env.MODEL_FAST_NAME
    delete process.env.MODEL_PROVIDER_URL
    claimSandboxInstance.mockImplementation(async (input: { id: string }) => ({
      record: input,
      inserted: true,
    }))
  })

  it("calls chat() with withSandbox and opencodeText", async () => {
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
    })
    expect(res.status).toBe(200)
    expect(opencodeTextMock).toHaveBeenCalledWith(
      "ctxpipe/openai/gpt-5.6-terra",
      expect.objectContaining({ permissionMode: "acceptEdits", port: 4096 }),
    )
    expect(createSecretsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        CTXPIPE_OPENCODE_RUN_TOKEN: expect.any(String),
        CTXPIPE_MODEL_PROXY_URL: "http://host.docker.internal:18789/v1",
      }),
    )
    expect(createSecretsMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        OPENCODE_CONFIG: expect.anything(),
      }),
    )
    expect(fileSkillMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "opencode.json" }),
    )
    expect(fileSkillMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: ".ctxpipe/CHAT.md" }),
    )
    expect(withSandboxMock).toHaveBeenCalled()
    expect(dockerSandboxMock).toHaveBeenCalledWith({
      image: "node:22",
      publishPorts: [4096],
    })
    expect(defineWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        setup: expect.arrayContaining([
          expect.stringMatching(/command -v opencode/),
        ]),
      }),
    )
    expect(chatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "conv_1",
        messages: [{ role: "user", content: "hello" }],
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: "hybrid_search",
            inputSchema: expect.objectContaining({ type: "object" }),
          }),
          expect.objectContaining({ name: "search" }),
          expect.objectContaining({ name: "list_repositories" }),
          expect.objectContaining({ name: "graph_lookup" }),
          expect.objectContaining({ name: "graph_neighbors" }),
          expect.objectContaining({ name: "graph_find_symbol" }),
        ]),
      }),
    )
    await res.text()
    expect(appendTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv_1",
        role: "user",
        content: "hello",
      }),
    )
    expect(appendTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv_1",
        role: "assistant",
        content: "ok",
      }),
    )
    expect(embedInTx.seen).toBe(false)
    expect(searchInTx.seen).toBe(false)
  })

  it("emits a conversation rename data part before finish", async () => {
    nameConversationIfUnnamedMock.mockResolvedValue("Billing ledger")
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("rename-conversation")
    expect(body).toContain("Billing ledger")
  })

  it("passes client messages and runId through to chat() without Postgres history", async () => {
    loadTurnsMock.mockResolvedValueOnce([
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
    ])
    const clientMessages = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "hello" },
    ]
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      messages: clientMessages,
      threadId: "conv_1",
      runId: "run_client",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
    })
    expect(res.status).toBe(200)
    expect(loadTurnsMock).not.toHaveBeenCalled()
    expect(chatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "conv_1",
        runId: "run_client",
        messages: clientMessages,
      }),
    )
    const events = parseSseDataLines(await res.text())
    expect(events[0]).toMatchObject({
      type: "RUN_STARTED",
      threadId: "conv_1",
      runId: "run_client",
    })
  })

  it("resumes the OpenCode session with modelOptions.sessionId", async () => {
    persistWorkspaceChatOpenCodeSessionId("conv_resume", "ses_prior")
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_resume",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
    })
    expect(res.status).toBe(200)
    expect(chatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "conv_resume",
        modelOptions: { sessionId: "ses_prior" },
      }),
    )
  })

  it("passes a clone token to gitSource without putting it in the sandbox id", async () => {
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
      cloneToken: "tok",
    })
    expect(res.status).toBe(200)
    expect(gitSourceMock).toHaveBeenCalledWith({
      url: "https://github.com/acme/docs",
      ref: "abc",
      auth: {
        token: expect.objectContaining({ __secretName: "CTXPIPE_CLONE_TOKEN" }),
      },
    })
    expect(createSecretsMock).toHaveBeenCalledWith(
      expect.objectContaining({ CTXPIPE_CLONE_TOKEN: "tok" }),
    )
    expect(defineSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "org_1:ws_1:https://github.com/acme/docs@abc:chat:1",
      }),
    )
    await res.text()
  })

  it("clones the default branch, not the projection SHA", async () => {
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      defaultBranch: "main",
      ref: "abc",
      writeStatus: "writable",
      cloneToken: "tok",
    })
    expect(res.status).toBe(200)
    expect(gitSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://github.com/acme/docs",
        ref: "main",
      }),
    )
    await res.text()
  })

  it("ensures a git checkout from onReady", async () => {
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      defaultBranch: "main",
      ref: "abc",
      writeStatus: "writable",
    })
    const onReady = defineSandboxMock.mock.calls[0]?.[0]?.hooks?.onReady as
      | ((handle: { process: { exec: unknown }; destroy: () => Promise<void> }) => Promise<void>)
      | undefined
    expect(onReady).toBeTypeOf("function")
    if (!onReady) throw new Error("expected onReady")
    const exec = vi.fn(async (command: string) => ({
      stdout: "",
      stderr: "",
      exitCode: command.includes("ss -lnt") || command.includes("nc -z") ? 1 : 0,
    }))
    await withTestLogger(() =>
      onReady({
        process: { exec },
        destroy: async () => {},
      }),
    )
    expect(String(exec.mock.calls[0]?.[0])).toContain("/tmp/ctxpipe-repo-clone")
    await res.text()
  })

  it("passes a Postgres instance store without a fake lock to withSandbox", async () => {
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
    })
    expect(res.status).toBe(200)
    expect(withSandboxMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        instances: expect.objectContaining({
          get: expect.any(Function),
          upsert: expect.any(Function),
          delete: expect.any(Function),
        }),
      }),
    )
    expect(withSandboxMock.mock.calls[0]?.[1]).not.toHaveProperty("locks")
    await res.text()
  })

  it("resumes a stored sbx chat sandbox through sbxSandbox", async () => {
    listSandboxInstancesMock.mockResolvedValueOnce([
      {
        id: "tanstack-key",
        kind: "chat",
        orgId: "org_1",
        workspaceId: "ws_1",
        conversationId: "conv_1",
        provider: "sbx",
        providerSandboxId: "sbx_vm",
        state: "live",
        lastHeartbeatAt: new Date(),
      },
    ])
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
    })
    expect(res.status).toBe(200)
    expect(sbxSandboxMock).toHaveBeenCalled()
    expect(dockerSandboxMock).not.toHaveBeenCalled()
    expect(defineSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "sbx-provider" }),
    )
    await res.text()
  })

  it("fails closed when the stored chat provider is unavailable", async () => {
    listSandboxInstancesMock.mockResolvedValueOnce([
      {
        id: "tanstack-key",
        kind: "chat",
        orgId: "org_1",
        workspaceId: "ws_1",
        conversationId: "conv_1",
        provider: "railway",
        providerSandboxId: "sbx_rail",
        state: "live",
        lastHeartbeatAt: new Date(),
      },
    ])
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
    })
    expect(res.status).toBe(200)
    const events = parseSseDataLines(await res.text())
    expect(events[0]).toMatchObject({ type: "RUN_STARTED" })
    expect(
      events.some((event) => (event as { type?: string }).type === "RUN_ERROR"),
    ).toBe(true)
    expect(dockerSandboxMock).not.toHaveBeenCalled()
    expect(chatMock).not.toHaveBeenCalled()
  })

  it("persists this-run assistant deltas only", async () => {
    chatMock.mockImplementationOnce(async function* () {
      yield { type: "TEXT_MESSAGE_CONTENT", delta: "only-this-run" }
      yield { type: "RUN_FINISHED" }
    })
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      messages: [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "old reply that must not be persisted" },
        { role: "user", content: "hello" },
      ],
      threadId: "conv_1",
      runId: "run_client",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
      userTurnAccepted: true,
    })
    expect(res.status).toBe(200)
    await res.text()
    expect(appendTurnMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ role: "user" }),
    )
    expect(appendTurnMock).toHaveBeenCalledTimes(1)
    expect(appendTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv_1",
        role: "assistant",
        content: "only-this-run",
      }),
    )
  })

  it("does not stream prompt echo and persists only the last reply", async () => {
    chatMock.mockImplementationOnce(async function* () {
      yield {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "user-part",
        delta: "hello",
      }
      yield {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "asst",
        delta: "only-this-run",
      }
      yield { type: "RUN_FINISHED" }
    })
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
    })
    expect(res.status).toBe(200)
    const events = parseSseDataLines(await res.text())
    const firstText = events.findIndex(
      (event) => (event as { type?: string }).type === "TEXT_MESSAGE_CONTENT",
    )
    const finished = events.findIndex(
      (event) => (event as { type?: string }).type === "RUN_FINISHED",
    )
    expect(firstText).toBeGreaterThanOrEqual(0)
    expect(finished).toBeGreaterThan(firstText)
    const text = events
      .filter(
        (event) => (event as { type?: string }).type === "TEXT_MESSAGE_CONTENT",
      )
      .map((event) => (event as { delta?: string }).delta ?? "")
      .join("")
    expect(text).toBe("only-this-run")
    expect(appendTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "assistant",
        content: "only-this-run",
      }),
    )
    expect(appendTurnMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        role: "assistant",
        content: "helloonly-this-run",
      }),
    )
  })

  it("reuses the local-process sandbox and leases an ephemeral serve port", async () => {
    delete process.env.SANDBOX_PROVIDER
    const { localProcessSandbox } = await import(
      "@tanstack/ai-sandbox-local-process"
    )
    listSandboxInstancesMock.mockResolvedValueOnce([
      {
        id: "thread:conv_1",
        kind: "chat",
        orgId: "org_1",
        workspaceId: "ws_1",
        conversationId: "conv_1",
        provider: "local-process",
        providerSandboxId: "/tmp/old",
        state: "live",
        lastHeartbeatAt: new Date(),
      },
    ])
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
    })
    expect(res.status).toBe(200)
    expect(opencodeTextMock).toHaveBeenCalledWith(
      "ctxpipe/openai/gpt-5.6-terra",
      expect.objectContaining({
        port: expect.any(Number),
      }),
    )
    const port = opencodeTextMock.mock.calls.at(-1)?.[1]?.port as number
    expect(port).not.toBe(4096)
    expect(defineSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycle: expect.objectContaining({ reuse: "thread" }),
      }),
    )
    expect(localProcessSandbox).toHaveBeenCalled()
    expect(dockerSandboxMock).not.toHaveBeenCalled()
    expect(createSecretsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        HOME: expect.stringContaining("ctxpipe-opencode-home"),
        XDG_CONFIG_HOME: expect.stringContaining("config"),
      }),
    )
    await res.text()
  })

  it("refuses Railway when no isolated provider exists", async () => {
    process.env.SANDBOX_PROVIDER = "railway"
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
    })
    expect(res.status).toBe(200)
    const events = parseSseDataLines(await res.text())
    expect(events[0]).toMatchObject({ type: "RUN_STARTED" })
    expect(
      events.some((event) => (event as { type?: string }).type === "RUN_ERROR"),
    ).toBe(true)
    expect(chatMock).not.toHaveBeenCalled()
  })

  it("falls back to the in-process provider when Docker is not locked", async () => {
    delete process.env.SANDBOX_PROVIDER
    const { localProcessSandbox } = await import(
      "@tanstack/ai-sandbox-local-process"
    )
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
    })
    expect(res.status).toBe(200)
    expect(localProcessSandbox).toHaveBeenCalledWith({
      scrubEnv: expect.arrayContaining([
        "AUTH_SECRET",
        "DATABASE_URL",
        "MODEL_PROVIDER_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
      ]),
    })
    await res.text()
  })

  it("fails closed before chat when the provider contract cannot run", async () => {
    delete process.env.MODEL_PROVIDER_API_KEY
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
    })
    expect(res.status).toBe(200)
    const events = parseSseDataLines(await res.text())
    expect(events[0]).toMatchObject({ type: "RUN_STARTED" })
    expect(JSON.stringify(events)).toContain("MODEL_PROVIDER_API_KEY")
    expect(chatMock).not.toHaveBeenCalled()
    expect(startWorkspaceChatModelProxyMock).not.toHaveBeenCalled()
  })

  it("omits retrieval tools without an active projection SHA", async () => {
    const empty = {
      id: "ws_1",
      orgId: "org_1",
      workspaceRepositoryUrl: "https://github.com/acme/docs",
      activeProjectionUrl: null,
      activeProjectionSha: null,
    }
    getWorkspaceById.mockResolvedValueOnce(empty).mockResolvedValueOnce(empty)
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
    })
    expect(res.status).toBe(200)
    expect(chatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [],
      }),
    )
    await res.text()
  })

  it("errors the stream on an OpenCode 500 instead of finishing empty", async () => {
    const onError = vi.fn(async () => {})
    const drained: Array<Record<string, unknown>> = []
    chatMock.mockImplementationOnce(
      // biome-ignore lint/correctness/useYield: the mocked stream fails before the first chunk
      async function* () {
        throw Object.assign(
          new Error("Unexpected server error. Check server logs for details."),
          { status: 500 },
        )
      },
    )
    initLogger({
      enabled: true,
      pretty: false,
      env: { service: "ctxpipe-backend-test" },
      drain: (ctx) => {
        drained.push(ctx.event as Record<string, unknown>)
      },
    })
    try {
      await withTestLogger(async () => {
        const res = await runTanstackWorkspaceChat({
          conversationId: "conv_1",
          prompt: "hello",
          orgId: "org_1",
          workspaceId: "ws_1",
          desiredUrl: "https://github.com/acme/docs",
          desiredSha: "abc",
          ref: "abc",
          writeStatus: "writable",
          onError,
        })
        expect(res.status).toBe(200)
        getLogger().emit()
        const events = parseSseDataLines(await res.text())
        expect(events[0]).toMatchObject({ type: "RUN_STARTED" })
        expect(
          events.some(
            (event) => (event as { type?: string }).type === "RUN_ERROR",
          ),
        ).toBe(true)
        expect(onError).toHaveBeenCalled()
        expect(appendTurnMock).toHaveBeenCalledWith(
          expect.objectContaining({
            conversationId: "conv_1",
            role: "user",
            content: "hello",
          }),
        )
        expect(appendTurnMock).not.toHaveBeenCalledWith(
          expect.objectContaining({ role: "assistant" }),
        )
        expect(getLogger().getContext().step).not.toBe("opencode.chatStream")
        expect(
          drained.find(
            (event) =>
              event.step === "opencode.chatStream" && event.status === 500,
          ),
        ).toMatchObject({
          conversationId: "conv_1",
          workspaceId: "ws_1",
          status: 500,
          bodyExcerpt:
            "Unexpected server error. Check server logs for details.",
        })
      })
    } finally {
      initLogger({
        enabled: false,
        env: { service: "ctxpipe-backend-test" },
      })
    }
  })

  it("errors an empty stream when TanStack only logs a console fatal", async () => {
    chatMock.mockImplementationOnce(
      // biome-ignore lint/correctness/useYield: TanStack logs a fatal and yields no chunks
      async function* () {
        console.error("❌ [tanstack-ai:errors] ❌ opencode.chatStream fatal")
      },
    )
    await withTestLogger(async () => {
      const res = await runTanstackWorkspaceChat({
        conversationId: "conv_1",
        prompt: "hello",
        orgId: "org_1",
        workspaceId: "ws_1",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        ref: "abc",
        writeStatus: "writable",
      })
      const events = parseSseDataLines(await res.text())
      expect(
        events.some(
          (event) => (event as { type?: string }).type === "RUN_ERROR",
        ),
      ).toBe(true)
      expect(appendTurnMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ role: "assistant" }),
      )
    })
  })

  it("refuses chat without a stored desired SHA", async () => {
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: null,
      ref: "HEAD",
      writeStatus: "writable",
    })
    expect(res.status).toBe(200)
    const events = parseSseDataLines(await res.text())
    expect(events[0]).toMatchObject({ type: "RUN_STARTED" })
    expect(JSON.stringify(events)).toContain("desired SHA")
    expect(chatMock).not.toHaveBeenCalled()
  })

  it("releases a pre-claimed turn when resolveRuntime throws", async () => {
    const accepted = claimWorkspaceChatTurn("conv_runtime_throw")
    expect(accepted).not.toBeNull()
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_runtime_throw",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
      acceptedTurn: accepted ?? undefined,
      resolveRuntime: async () => {
        throw new Error("runtime boom")
      },
    })
    await res.text().catch(() => undefined)
    expect(workspaceChatTurnIsBusy("conv_runtime_throw")).toBe(false)
    expect(claimWorkspaceChatTurn("conv_runtime_throw")).not.toBeNull()
  })

  it("writes the first AG-UI event before resolveRuntime / OpenCode work", async () => {
    let resolved = false
    const res = await runTanstackWorkspaceChatHttp({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
      resolveRuntime: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
        resolved = true
        return {}
      },
    })
    const reader = res.body?.getReader()
    expect(reader).toBeTruthy()
    const first = await reader?.read()
    const text = new TextDecoder().decode(first?.value)
    expect(text).toContain("RUN_STARTED")
    expect(resolved).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(resolved).toBe(true)
    await reader?.cancel()
  })

  it("keeps the sandbox definition stable when run token and runId change", async () => {
    await (
      await runTanstackWorkspaceChat({
        conversationId: "conv_1",
        prompt: "hello",
        orgId: "org_1",
        workspaceId: "ws_1",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        ref: "main",
        writeStatus: "writable",
        runId: "run_a",
        cloneToken: "tok-a",
      })
    ).text()
    const firstOpencodeSkill = fileSkillMock.mock.calls.find(
      (call) => call[0]?.path === "opencode.json",
    )?.[0]
    const firstId = defineSandboxMock.mock.calls[0]?.[0]?.id
    await (
      await runTanstackWorkspaceChat({
        conversationId: "conv_1",
        prompt: "hello",
        orgId: "org_1",
        workspaceId: "ws_1",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        ref: "other-branch",
        writeStatus: "writable",
        runId: "run_b",
        cloneToken: "tok-b",
      })
    ).text()
    const secondOpencodeSkill = fileSkillMock.mock.calls
      .filter((call) => call[0]?.path === "opencode.json")
      .at(-1)?.[0]
    expect(defineSandboxMock.mock.calls[1]?.[0]?.id).toBe(firstId)
    expect(secondOpencodeSkill).toEqual(firstOpencodeSkill)
    expect(String(firstOpencodeSkill?.content)).toContain(
      "{env:CTXPIPE_MODEL_PROXY_URL}",
    )
    expect(String(firstOpencodeSkill?.content)).not.toContain("18789")
    expect(startWorkspaceChatModelProxyMock).toHaveBeenCalledTimes(1)
    expect(gitSourceMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ref: "abc",
        auth: {
          token: expect.objectContaining({
            __secretName: "CTXPIPE_CLONE_TOKEN",
          }),
        },
      }),
    )
  })

  it("leases a distinct local-process port per conversation", async () => {
    delete process.env.SANDBOX_PROVIDER
    chatMock.mockImplementation(async function* () {
      yield { type: "TEXT_MESSAGE_CONTENT", delta: "pong" }
      yield { type: "RUN_FINISHED" }
    })
    await (
      await runTanstackWorkspaceChat({
        conversationId: "conv_a",
        prompt: "hello",
        orgId: "org_1",
        workspaceId: "ws_1",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        ref: "abc",
        writeStatus: "writable",
      })
    ).text()
    await (
      await runTanstackWorkspaceChat({
        conversationId: "conv_b",
        prompt: "hello",
        orgId: "org_1",
        workspaceId: "ws_1",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        ref: "abc",
        writeStatus: "writable",
      })
    ).text()
    const ports = opencodeTextMock.mock.calls.map(
      (call) => (call[1] as { port?: number }).port,
    )
    expect(ports).toHaveLength(2)
    expect(ports[0]).not.toBe(ports[1])
    expect(ports[0]).not.toBe(4096)
    expect(ports[1]).not.toBe(4096)
  })

  it("attaches to a live conversation serve instead of spawning opencodeText", async () => {
    setWorkspaceChatConversationRuntime({
      conversationId: "conv_1",
      runToken: "tok",
      proxy: {
        baseUrl: "http://127.0.0.1:18789",
        close: vi.fn(async () => {}),
      },
      proxyLease: null,
      servePort: 4097,
      servePortLease: null,
      tools: [],
      serve: {
        baseUrl: "http://127.0.0.1:4097",
        dispose: vi.fn(async () => {}),
      },
    })
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "what's in this repo?",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "read_only",
    })
    expect(res.status).toBe(200)
    expect(streamAttachedOpenCodeTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:4097",
        prompt: "what's in this repo?",
      }),
    )
    expect(opencodeTextMock).not.toHaveBeenCalled()
    expect(chatMock).not.toHaveBeenCalled()
    await res.text()
  })

  it("rejects a second overlapping stream on the same conversation", async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    chatMock.mockImplementationOnce(async function* () {
      yield { type: "TEXT_MESSAGE_CONTENT", delta: "hold" }
      await hold
      yield { type: "RUN_FINISHED" }
    })
    const first = await runTanstackWorkspaceChatHttp({
      conversationId: "conv_busy",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
    })
    const reader = first.body?.getReader()
    const decoder = new TextDecoder()
    if (!reader) throw new Error("expected stream body")
    for (let i = 0; i < 8; i++) {
      const { value, done } = await reader.read()
      if (done) break
      if (decoder.decode(value).includes("TEXT_MESSAGE_CONTENT")) break
    }
    const second = await runTanstackWorkspaceChat({
      conversationId: "conv_busy",
      prompt: "again",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
    })
    const secondEvents = parseSseDataLines(await second.text())
    expect(
      secondEvents.some(
        (event) =>
          (event as { type?: string }).type === "RUN_ERROR" &&
          String((event as { message?: string }).message).includes(
            "conversation_busy",
          ),
      ),
    ).toBe(true)
    release()
    while (!(await reader.read()).done) {
      /* drain */
    }
  })

  it("keeps the user turn and skips assistant persist on ServeError", async () => {
    chatMock.mockImplementationOnce(async function* () {
      yield {
        type: "RUN_ERROR",
        message: "opencode serve exited before becoming ready",
      }
    })
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_1",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
    })
    const events = parseSseDataLines(await res.text())
    expect(
      events.some((event) => (event as { type?: string }).type === "RUN_ERROR"),
    ).toBe(true)
    expect(appendTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "hello" }),
    )
    expect(appendTurnMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant" }),
    )
  })

  it("invalidates the sandbox after a ServeError before session-id", async () => {
    const { deleteSandboxInstance } = await import("../../models/workspaces.js")
    listSandboxInstancesMock.mockResolvedValueOnce([]).mockResolvedValue([
      {
        id: "thread:conv_1",
        kind: "chat",
        orgId: "org_1",
        workspaceId: "ws_1",
        conversationId: "conv_1",
        provider: "local-process",
        providerSandboxId: "/tmp/old",
        state: "live",
        lastHeartbeatAt: new Date(),
      },
    ])
    chatMock.mockImplementationOnce(async function* () {
      yield {
        type: "RUN_ERROR",
        message: "opencode serve exited before becoming ready",
      }
    })
    await (
      await runTanstackWorkspaceChat({
        conversationId: "conv_1",
        prompt: "hello",
        orgId: "org_1",
        workspaceId: "ws_1",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        ref: "abc",
        writeStatus: "writable",
      })
    ).text()
    expect(deleteSandboxInstance).toHaveBeenCalledWith("thread:conv_1", "org_1")
  })

  it("finishes a turn when OpenCode emits RUN_FINISHED then hangs", async () => {
    chatMock.mockImplementationOnce(async function* () {
      yield { type: "TEXT_MESSAGE_CONTENT", delta: "ok" }
      yield { type: "RUN_FINISHED" }
      await new Promise(() => {})
    })
    const res = await Promise.race([
      runTanstackWorkspaceChat({
        conversationId: "conv_hang_finish",
        prompt: "hello",
        orgId: "org_1",
        workspaceId: "ws_1",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        ref: "abc",
        writeStatus: "writable",
        streamIdleMs: 200,
        streamSetupMs: 200,
      }),
      new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error("turn did not finish")), 500),
      ),
    ])
    expect(res.status).toBe(200)
    expect(workspaceChatTurnIsBusy("conv_hang_finish")).toBe(false)
    expect(appendTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", content: "ok" }),
    )
    expect(claimWorkspaceChatTurn("conv_hang_finish")).not.toBeNull()
  })

  it("persists late OpenCode assistant text after prompt() ends empty", async () => {
    chatMock.mockImplementationOnce(async function* () {
      yield {
        type: "CUSTOM",
        name: "opencode.session-id",
        value: { sessionId: "ses_late" },
      }
      yield { type: "TEXT_MESSAGE_CONTENT", delta: "hello" }
      yield { type: "RUN_FINISHED" }
    })
    const openCodeFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "late-ok" }],
          },
        ]),
        { status: 200 },
      ),
    )
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_late",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
      openCodeIdleMs: 50,
      openCodeFetch,
    })
    const events = parseSseDataLines(await res.text())
    expect(
      events.some(
        (event) =>
          (event as { type?: string }).type === "TEXT_MESSAGE_CONTENT" &&
          (event as { delta?: string }).delta === "late-ok",
      ),
    ).toBe(true)
    expect(appendTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", content: "late-ok" }),
    )
    expect(openCodeFetch).toHaveBeenCalled()
  })

  it("waits for late text when the stream only had a planning preamble", async () => {
    chatMock.mockImplementationOnce(async function* () {
      yield {
        type: "CUSTOM",
        name: "opencode.session-id",
        value: { sessionId: "ses_plan" },
      }
      yield {
        type: "TEXT_MESSAGE_CONTENT",
        delta:
          "I’ll inspect the repository structure and its primary project metadata to summarize its purpose and components.",
      }
      yield { type: "RUN_FINISHED" }
    })
    const openCodeFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "This repo is a TypeScript monorepo." }],
          },
        ]),
        { status: 200 },
      ),
    )
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_plan",
      prompt: "what's in this repo?",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
      openCodeIdleMs: 50,
      openCodeFetch,
    })
    expect(appendTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "assistant",
        content: "This repo is a TypeScript monorepo.",
      }),
    )
    expect(openCodeFetch).toHaveBeenCalled()
    await res.text()
  })

  it("releases the claim when the producer stalls after echo", async () => {
    chatMock.mockImplementationOnce(async function* () {
      yield { type: "CUSTOM", name: "opencode.session-id", value: "ses_1" }
      yield { type: "TEXT_MESSAGE_CONTENT", delta: "hello" }
      await new Promise(() => {})
    })
    const res = await runTanstackWorkspaceChat({
      conversationId: "conv_stall",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      ref: "abc",
      writeStatus: "writable",
      streamIdleMs: 20,
      streamSetupMs: 20,
    })
    const events = parseSseDataLines(await res.text())
    expect(
      events.some(
        (event) =>
          (event as { type?: string }).type === "RUN_ERROR" &&
          String((event as { message?: string }).message).includes("stalled"),
      ),
    ).toBe(true)
    expect(workspaceChatTurnIsBusy("conv_stall")).toBe(false)
    expect(appendTurnMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant" }),
    )
  })
})
