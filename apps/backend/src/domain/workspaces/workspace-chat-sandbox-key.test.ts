import { describe, expect, it, vi } from "vitest"
import {
  createSecrets,
  defineSandbox,
  defineWorkspace,
  gitSource,
  type SandboxCapabilities,
  type SandboxCreateInput,
  type SandboxHandle,
  type SandboxResumeInput,
} from "@tanstack/ai-sandbox"
import {
  CHAT_SANDBOX_KEEP_ALIVE,
  WORKSPACE_CHAT_CLONE_TOKEN_SECRET,
  WORKSPACE_CHAT_SANDBOX_SETUP,
  workspaceChatCloneTokenRef,
  workspaceChatGitSource,
  workspaceChatSandboxId,
} from "./chat-runtime.js"
import {
  WORKSPACE_CHAT_OPENCODE_JSON_SECRET,
  workspaceChatOpenCodeConfig,
  workspaceChatOpenCodeHomeEnv,
} from "./workspace-chat-opencode-contract.js"

const fakeCapabilities: SandboxCapabilities = {
  fs: true,
  exec: true,
  env: true,
  ports: false,
  backgroundProcesses: false,
  writableStdin: false,
  killableProcesses: false,
  snapshots: false,
  networkPolicy: false,
  durableFilesystem: true,
  fork: false,
}

function fakeHandle(id: string): SandboxHandle {
  return {
    id,
    provider: "local-process",
    capabilities: fakeCapabilities,
    env: { set: async () => undefined },
    fs: {
      exists: async () => true,
      write: async () => undefined,
      read: async () => "",
      readBytes: async () => new Uint8Array(),
      list: async () => [],
      mkdir: async () => undefined,
      remove: async () => undefined,
      rename: async () => undefined,
    },
    git: {
      clone: async () => undefined,
      status: async () => "",
      add: async () => undefined,
      commit: async () => undefined,
      push: async () => undefined,
      pull: async () => undefined,
      branch: async () => "main",
    },
    process: {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      spawn: async () => {
        throw new Error("spawn is not used in this test")
      },
    },
    ports: {
      connect: async () => ({ url: "http://127.0.0.1:1" }),
    },
    destroy: async () => undefined,
  }
}

function chatWorkspace(input: {
  url: string
  ref: string
  cloneToken?: string
  proxyUrl: string
  runToken: string
}) {
  const secrets = createSecrets({
    CTXPIPE_OPENCODE_RUN_TOKEN: input.runToken,
    CTXPIPE_MODEL_PROXY_URL: input.proxyUrl,
    [WORKSPACE_CHAT_OPENCODE_JSON_SECRET]: JSON.stringify(
      workspaceChatOpenCodeConfig({ modelBase: "openai/gpt-5.6-terra" }),
    ),
    ...workspaceChatOpenCodeHomeEnv("conv_key"),
    ...(input.cloneToken
      ? { [WORKSPACE_CHAT_CLONE_TOKEN_SECRET]: input.cloneToken }
      : {}),
  })
  return defineWorkspace({
    source: gitSource(
      workspaceChatGitSource({
        url: input.url,
        ref: input.ref,
        token: workspaceChatCloneTokenRef(secrets, input.cloneToken),
      }) as Parameters<typeof gitSource>[0],
    ),
    setup: [...WORKSPACE_CHAT_SANDBOX_SETUP],
    secrets,
  })
}

function sandboxKey(input: {
  conversationId: string
  runId: string
  providerName: string
  desiredUrl: string
  desiredSha: string
  cloneToken?: string
  proxyUrl?: string
  runToken?: string
}) {
  const sandboxId = workspaceChatSandboxId({
    orgId: "org_1",
    workspaceId: "ws_1",
    desiredUrl: input.desiredUrl,
    desiredSha: input.desiredSha,
    image: "chat:1",
  })
  if (!sandboxId) throw new Error("expected sandbox id")
  return defineSandbox({
    id: sandboxId,
    provider: {
      name: input.providerName,
      capabilities: () => fakeCapabilities,
      create: async (createInput) => fakeHandle(createInput.id ?? "sbx"),
      resume: async (resumeInput) => fakeHandle(resumeInput.id),
      destroy: async () => undefined,
    },
    workspace: chatWorkspace({
      url: input.desiredUrl,
      ref: input.desiredSha,
      cloneToken: input.cloneToken,
      proxyUrl: input.proxyUrl ?? "http://127.0.0.1:18789/v1",
      runToken: input.runToken ?? "run-token",
    }),
    lifecycle: {
      reuse: "thread",
      snapshot: "after-setup",
      keepAlive: CHAT_SANDBOX_KEEP_ALIVE,
      destroyOnComplete: false,
    },
  }).key({
    threadId: input.conversationId,
    runId: input.runId,
  })
}

describe("workspace chat sandbox opaque key", () => {
  it("stays the same when proxy URL, run token, runId, and clone token rotate", () => {
    const first = sandboxKey({
      conversationId: "conv_1",
      runId: "run_a",
      providerName: "local-process",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      cloneToken: "tok-a",
      proxyUrl: "http://127.0.0.1:18789/v1",
      runToken: "token-a",
    })
    const second = sandboxKey({
      conversationId: "conv_1",
      runId: "run_b",
      providerName: "local-process",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      cloneToken: "tok-b",
      proxyUrl: "http://127.0.0.1:19999/v1",
      runToken: "token-b",
    })
    expect(first).toBe(second)
  })

  it("changes when conversation, provider, or desiredSha change", () => {
    const base = {
      runId: "run_a",
      cloneToken: "tok-a",
      desiredUrl: "https://github.com/acme/docs",
    }
    const first = sandboxKey({
      ...base,
      conversationId: "conv_1",
      providerName: "local-process",
      desiredSha: "abc",
    })
    expect(
      sandboxKey({
        ...base,
        conversationId: "conv_2",
        providerName: "local-process",
        desiredSha: "abc",
      }),
    ).not.toBe(first)
    expect(
      sandboxKey({
        ...base,
        conversationId: "conv_1",
        providerName: "docker",
        desiredSha: "abc",
      }),
    ).not.toBe(first)
    expect(
      sandboxKey({
        ...base,
        conversationId: "conv_1",
        providerName: "local-process",
        desiredSha: "def",
      }),
    ).not.toBe(first)
  })

  it("creates once and resumes the same workdir on the second turn", async () => {
    const create = vi.fn(async (input: SandboxCreateInput) =>
      fakeHandle(input.id ?? "sbx"),
    )
    const resume = vi.fn(async (input: SandboxResumeInput) =>
      fakeHandle(input.id),
    )
    const sandboxId = workspaceChatSandboxId({
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      image: "chat:1",
    })
    if (!sandboxId) throw new Error("expected sandbox id")
    const definition = defineSandbox({
      id: sandboxId,
      provider: {
        name: "local-process",
        capabilities: () => fakeCapabilities,
        create,
        resume,
        destroy: async () => undefined,
      },
      workspace: {
        ...chatWorkspace({
          url: "https://github.com/acme/docs",
          ref: "abc",
          cloneToken: "tok-a",
          proxyUrl: "http://127.0.0.1:1/v1",
          runToken: "a",
        }),
        setup: [],
        skills: [],
      },
      lifecycle: {
        reuse: "thread",
        snapshot: "after-setup",
        keepAlive: CHAT_SANDBOX_KEEP_ALIVE,
        destroyOnComplete: false,
      },
    })
    const store = new Map<
      string,
      {
        key: string
        provider: string
        providerSandboxId: string
        threadId: string
        updatedAt: number
      }
    >()
    const instances = {
      get: async (key: string) => store.get(key) ?? null,
      upsert: async (record: {
        key: string
        provider: string
        providerSandboxId: string
        threadId: string
        updatedAt: number
      }) => {
        store.set(record.key, record)
      },
      delete: async (key: string) => {
        store.delete(key)
      },
    }
    const first = await definition.ensure({
      threadId: "conv_1",
      runId: "run_a",
      store: instances,
    })
    const secondWorkspace = chatWorkspace({
      url: "https://github.com/acme/docs",
      ref: "abc",
      cloneToken: "tok-b",
      proxyUrl: "http://127.0.0.1:2/v1",
      runToken: "b",
    })
    const secondDefinition = defineSandbox({
      id: sandboxId,
      provider: {
        name: "local-process",
        capabilities: () => fakeCapabilities,
        create,
        resume,
        destroy: async () => undefined,
      },
      workspace: { ...secondWorkspace, setup: [], skills: [] },
      lifecycle: {
        reuse: "thread",
        snapshot: "after-setup",
        keepAlive: CHAT_SANDBOX_KEEP_ALIVE,
        destroyOnComplete: false,
      },
    })
    const second = await secondDefinition.ensure({
      threadId: "conv_1",
      runId: "run_b",
      store: instances,
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(first.id).toBe(second.id)
    expect(store.size).toBe(1)
  })
})
