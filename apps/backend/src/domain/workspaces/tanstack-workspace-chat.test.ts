import { beforeEach, describe, expect, it, vi } from "vitest"

const chatMock = vi.hoisted(() =>
  vi.fn(async function* (opts: { threadId?: string; runId?: string }) {
    yield {
      type: "RUN_STARTED",
      threadId: opts.threadId,
      runId: opts.runId ?? "run_chat",
    }
    yield { type: "TEXT_MESSAGE_CONTENT", delta: "ok" }
    yield { type: "RUN_FINISHED" }
  }),
)
const opencodeTextMock = vi.hoisted(() =>
  vi.fn((_model?: string, _opts?: { port?: number }) => "adapter"),
)
const ensureSandboxMock = vi.hoisted(() =>
  vi.fn(async () => ({
    id: "sbx_ready",
    process: { exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })) },
    destroy: vi.fn(async () => {}),
  })),
)
const defineSandboxMock = vi.hoisted(() =>
  vi.fn((input) => ({ ...input, ensure: ensureSandboxMock })),
)
const defineWorkspaceMock = vi.hoisted(() => vi.fn((input) => input))
const gitSourceMock = vi.hoisted(() => vi.fn((input) => input))
const withSandboxMock = vi.hoisted(() =>
  vi.fn((def: unknown, _opts?: unknown) => def),
)
const memorySandboxSnapshotsMock = vi.hoisted(() =>
  vi.fn(async () => ({
    persistence: { stores: {} },
    checkpoints: {},
  })),
)
const dockerSandboxMock = vi.hoisted(() => vi.fn(() => "docker-provider"))
const sbxSandboxMock = vi.hoisted(() => vi.fn(() => "sbx-provider"))
const listSandboxInstancesMock = vi.hoisted(() =>
  vi.fn(async (): Promise<Array<{ provider?: string; providerSandboxId?: string }>> => []),
)
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
const withPersistenceMock = vi.hoisted(() => vi.fn((persistence: unknown) => persistence))
const nameConversationIfUnnamedMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(null),
)

vi.mock("@tanstack/ai", () => ({
  chat: chatMock,
  toServerSentEventsResponse: (
    stream: AsyncIterable<object>,
  ): Response => {
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
  },
  toHttpResponse: vi.fn(),
  modelMessagesToUIMessages: (messages: unknown[]) => messages,
}))
vi.mock("@tanstack/ai-opencode", () => ({ opencodeText: opencodeTextMock }))
vi.mock("@tanstack/ai-persistence", () => ({
  withPersistence: withPersistenceMock,
}))
vi.mock("@tanstack/ai/middlewares/otel", () => ({
  otelMiddleware: () => "otel",
}))
vi.mock("@tanstack/ai-sandbox", () => ({
  defineSandbox: defineSandboxMock,
  defineWorkspace: defineWorkspaceMock,
  gitSource: gitSourceMock,
  fileSkill: fileSkillMock,
  createSecrets: createSecretsMock,
  withSandbox: withSandboxMock,
  memorySandboxSnapshots: memorySandboxSnapshotsMock,
  createSandboxSnapshots: vi.fn((input: unknown) => input),
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
vi.mock("./workspace-chat-persistence.js", () => ({
  workspaceChatPersistence: () => ({
    stores: {
      messages: {
        loadThread: async () => [],
        saveThread: async () => {},
      },
    },
  }),
}))
vi.mock("../../graphs/conversationGraph/nodes/conversationNaming.js", () => ({
  nameConversationIfUnnamed: nameConversationIfUnnamedMock,
}))
vi.mock("../../db/client.js", () => ({
  tryGetOrgDb: () => undefined,
  tryGetOrgDbOrgId: () => undefined,
  assertNotInOrgDbContext: () => undefined,
  withOrgDbContext: async (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../../auth/withAuth.js", () => ({
  withOrgIdContext: (_org: unknown, fn: () => unknown) => fn(),
}))
vi.mock("../../models/conversation-messages.js", () => ({
  loadConversationTurns: vi.fn(async () => []),
  appendConversationTurn: vi.fn(async () => {}),
}))
vi.mock("../../models/workspaces.js", () => ({
  persistSandboxInstance: vi.fn(async () => {}),
  deleteSandboxInstance: vi.fn(async () => {}),
  claimSandboxInstance: vi.fn(async (input: { id: string }) => ({
    record: input,
    inserted: true,
  })),
  listSandboxInstances: listSandboxInstancesMock,
  heartbeatSandboxInstance: vi.fn(async () => {}),
  getSandboxInstance: vi.fn(async () => null),
  getWorkspaceById: vi.fn(async () => ({
    id: "ws_1",
    orgId: "org_1",
    workspaceRepositoryUrl: "https://github.com/acme/docs",
    activeProjectionUrl: "https://github.com/acme/docs",
    activeProjectionSha: "abc",
  })),
  listLinkedRepositories: vi.fn(async () => []),
  listWorkspaceKnowledgeUnits: vi.fn(async () => ({
    units: [],
    lastUpdatedAt: null,
  })),
  listWorkspaceKnowledgeUnitsForChat: vi.fn(async () => []),
}))
vi.mock("../../retrieval/index.js", () => ({
  hybridSearch: async () => [],
}))
vi.mock("../../retrieval/services/modelProvider.js", () => ({
  generateEmbedding: async () => [1, 0, 0],
}))

import {
  runTanstackWorkspaceChat as runTanstackWorkspaceChatHttp,
  streamTanstackWorkspaceChat,
  warmTanstackWorkspaceChat,
} from "./tanstack-workspace-chat.js"
import { parseSseDataLines } from "./workspace-chat-agui.js"

const baseInput = {
  conversationId: "conv_1",
  prompt: "hello",
  orgId: "org_1",
  workspaceId: "ws_1",
  desiredUrl: "https://github.com/acme/docs",
  desiredSha: "abc",
  ref: "abc",
  writeStatus: "writable" as const,
}

async function runTanstackWorkspaceChat(
  input: Parameters<typeof runTanstackWorkspaceChatHttp>[0],
) {
  const res = await runTanstackWorkspaceChatHttp(input)
  const body = await res.text()
  return new Response(body, { status: res.status, headers: res.headers })
}

describe("runTanstackWorkspaceChat", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nameConversationIfUnnamedMock.mockResolvedValue(null)
    listSandboxInstancesMock.mockResolvedValue([])
    process.env.SANDBOX_PROVIDER = "docker"
    process.env.MODEL_PROVIDER = "openai-like"
    process.env.MODEL_PROVIDER_API_KEY = "sk-test-chat"
    delete process.env.MODEL_FAST_NAME
    delete process.env.MODEL_PROVIDER_URL
  })

  it("calls chat() with withPersistence, withSandbox, and opencodeText", async () => {
    const res = await runTanstackWorkspaceChat(baseInput)
    expect(res.status).toBe(200)
    expect(opencodeTextMock).toHaveBeenCalledWith(
      "ctxpipe/openai/gpt-5.6-terra",
      expect.objectContaining({ permissionMode: "acceptEdits", port: 4096 }),
    )
    expect(withPersistenceMock).toHaveBeenCalled()
    expect(withSandboxMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        instances: expect.objectContaining({
          get: expect.any(Function),
          upsert: expect.any(Function),
          delete: expect.any(Function),
        }),
        snapshots: expect.objectContaining({
          persistence: expect.anything(),
        }),
      }),
    )
    expect(chatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "conv_1",
        messages: [],
      }),
    )
    expect(defineWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        setup: expect.arrayContaining([
          expect.stringMatching(/command -v opencode/),
          expect.stringMatching(/CTXPIPE_CLONE_URL/),
        ]),
      }),
    )
  })

  it("passes client messages and runId through to chat()", async () => {
    const clientMessages = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "hello" },
    ]
    const res = await runTanstackWorkspaceChat({
      ...baseInput,
      messages: clientMessages,
      threadId: "conv_1",
      runId: "run_client",
    })
    expect(res.status).toBe(200)
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

  it("emits a conversation rename data part before finish", async () => {
    nameConversationIfUnnamedMock.mockResolvedValue("Billing ledger")
    const res = await runTanstackWorkspaceChat(baseInput)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("rename-conversation")
    expect(body).toContain("Billing ledger")
  })

  it("passes a clone token to gitSource without putting it in the sandbox id", async () => {
    const res = await runTanstackWorkspaceChat({
      ...baseInput,
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
    expect(defineSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "org_1:ws_1:https://github.com/acme/docs@abc:chat:1",
      }),
    )
  })

  it("resumes a stored sbx chat sandbox through sbxSandbox", async () => {
    listSandboxInstancesMock.mockResolvedValueOnce([
      { provider: "sbx", providerSandboxId: "sbx_vm" },
    ])
    const res = await runTanstackWorkspaceChat(baseInput)
    expect(res.status).toBe(200)
    expect(sbxSandboxMock).toHaveBeenCalled()
    expect(dockerSandboxMock).not.toHaveBeenCalled()
  })

  it("fails closed when the stored chat provider is unavailable", async () => {
    listSandboxInstancesMock.mockResolvedValueOnce([
      { provider: "railway", providerSandboxId: "sbx_rail" },
    ])
    const res = await runTanstackWorkspaceChat(baseInput)
    expect(res.status).toBe(200)
    const events = parseSseDataLines(await res.text())
    expect(events[0]).toMatchObject({ type: "RUN_STARTED" })
    expect(
      events.some((event) => (event as { type?: string }).type === "RUN_ERROR"),
    ).toBe(true)
    expect(chatMock).not.toHaveBeenCalled()
  })

  it("does not stream prompt echo", async () => {
    chatMock.mockImplementationOnce(async function* () {
      yield { type: "RUN_STARTED", threadId: "conv_1", runId: "run_1" }
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
    const res = await runTanstackWorkspaceChat(baseInput)
    const events = parseSseDataLines(await res.text())
    const text = events
      .filter(
        (event) => (event as { type?: string }).type === "TEXT_MESSAGE_CONTENT",
      )
      .map((event) => (event as { delta?: string }).delta ?? "")
      .join("")
    expect(text).toBe("only-this-run")
  })
})

describe("warmTanstackWorkspaceChat", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listSandboxInstancesMock.mockResolvedValue([])
    process.env.SANDBOX_PROVIDER = "docker"
    process.env.MODEL_PROVIDER = "openai-like"
    process.env.MODEL_PROVIDER_API_KEY = "sk-test-chat"
  })

  it("ensures the sandbox without starting opencodeText", async () => {
    const warmed = await warmTanstackWorkspaceChat({
      ...baseInput,
      prompt: "prepare",
    })
    expect(warmed).toEqual({ ok: true })
    expect(ensureSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "conv_1",
        adapterName: "opencode",
      }),
    )
    expect(opencodeTextMock).not.toHaveBeenCalled()
    expect(chatMock).not.toHaveBeenCalled()
    expect(startWorkspaceChatModelProxyMock).not.toHaveBeenCalled()
  })
})

describe("streamTanstackWorkspaceChat", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listSandboxInstancesMock.mockResolvedValue([])
    process.env.SANDBOX_PROVIDER = "docker"
    process.env.MODEL_PROVIDER = "openai-like"
    process.env.MODEL_PROVIDER_API_KEY = "sk-test-chat"
  })

  it("touches lastMessageAt before chat() when onUserPersist is set", async () => {
    const order: string[] = []
    for await (const chunk of streamTanstackWorkspaceChat({
      ...baseInput,
      onUserPersist: async () => {
        order.push("persist-user")
      },
    })) {
      if ((chunk as { type?: string }).type === "RUN_STARTED") {
        order.push("run-started")
      }
    }
    expect(order[0]).toBe("persist-user")
    expect(order).toContain("run-started")
  })
})
