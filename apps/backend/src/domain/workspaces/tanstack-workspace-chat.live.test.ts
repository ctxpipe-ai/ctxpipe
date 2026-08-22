import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chat } from "@tanstack/ai"
import { opencodeText } from "@tanstack/ai-opencode"
import {
  createSecrets,
  defineSandbox,
  defineWorkspace,
  fileSkill,
  gitSource,
  withSandbox,
} from "@tanstack/ai-sandbox"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { describe, expect, it } from "vitest"
import { WORKSPACE_CHAT_SANDBOX_SETUP } from "./chat-runtime.js"
import { startWorkspaceChatModelProxy } from "./workspace-chat-model-proxy.js"
import {
  WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV,
  workspaceChatOpenCodeConfig,
  workspaceChatOpenCodeContract,
} from "./workspace-chat-opencode-contract.js"

const live = process.env.OPENCODE_LIVE === "1"

describe.skipIf(!live)("workspace chat OpenCode fallback (live)", () => {
  it("scrubs host provider keys from the local-process env", async () => {
    process.env.MODEL_PROVIDER_API_KEY = "sk-must-not-leak"
    process.env.ANTHROPIC_API_KEY = "sk-anthropic-must-not-leak"
    const provider = localProcessSandbox({
      scrubEnv: [...WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV],
    })
    const handle = await provider.create({ id: "scrub-live" })
    try {
      const leaked = await handle.process.exec(
        "printenv MODEL_PROVIDER_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY || true",
      )
      expect(leaked.stdout).not.toContain("sk-must-not-leak")
      expect(leaked.stdout).not.toContain("sk-anthropic-must-not-leak")
    } finally {
      await handle.destroy()
    }
  })

  it("streams a stub completion through the ctxpipe proxy on local_process", async () => {
    isolateHome()
    const upstreamHits: Array<{ host: string; model: string; path: string }> =
      []
    const upstream = await listenOpenAiStub(async (req, url) => {
      const body = (await req.json()) as { model?: string }
      upstreamHits.push({
        host: url.host,
        model: body.model ?? "",
        path: url.pathname,
      })
      return {
        id: "chatcmpl_live",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "fallback-stub-ok" },
            finish_reason: "stop",
          },
        ],
      }
    })
    process.env.MODEL_PROVIDER = "openai-like"
    process.env.MODEL_PROVIDER_API_KEY = "sk-live-upstream"
    process.env.MODEL_PROVIDER_URL = `${upstream.baseUrl}/v1`
    delete process.env.MODEL_FAST_NAME
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENROUTER_API_KEY
    delete process.env.SANDBOX_PROVIDER

    const contract = workspaceChatOpenCodeContract(process.env)
    expect(contract.ok).toBe(true)
    if (!contract.ok) return

    const runToken = "live-run-token"
    const proxy = await startWorkspaceChatModelProxy({
      runToken,
      upstreamBaseUrl: contract.upstreamBaseUrl,
      upstreamApiKey: contract.apiKey,
      modelBase: contract.modelBase,
      modelParams: contract.modelParams,
    })
    const config = workspaceChatOpenCodeConfig({
      modelBase: contract.modelBase,
      baseUrl: `${proxy.baseUrl}/v1`,
    })
    const configPath = join(tmpdir(), "ctxpipe-opencode-live.json")
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
    const source = makeGitRepo()
    const chunks: object[] = []
    try {
      const stream = chat({
        adapter: opencodeText(contract.opencodeModel, {
          port: 4096,
          permissionMode: "acceptEdits",
        }),
        threadId: "conv_live_fallback",
        messages: [{ role: "user", content: "say ok" }],
        middleware: [
          withSandbox(
            defineSandbox({
              id: `live:${source.ref}`,
              provider: localProcessSandbox({
                scrubEnv: [...WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV],
              }),
              workspace: defineWorkspace({
                source: gitSource({ url: source.url, ref: source.ref }),
                setup: [...WORKSPACE_CHAT_SANDBOX_SETUP],
                secrets: createSecrets({
                  CTXPIPE_OPENCODE_RUN_TOKEN: runToken,
                  OPENCODE_CONFIG: configPath,
                }),
                skills: [
                  fileSkill({
                    path: "opencode.json",
                    content: `${JSON.stringify(config, null, 2)}\n`,
                  }),
                ],
              }),
              lifecycle: {
                reuse: "thread",
                snapshot: "after-setup",
                keepAlive: "5m",
              },
            }),
          ),
        ],
      })
      for await (const chunk of stream as AsyncIterable<object>) {
        chunks.push(chunk)
      }
    } finally {
      await proxy.close()
      await upstream.close()
    }

    const text = chunks
      .map((chunk) => {
        const record = chunk as { type?: string; delta?: string }
        return record.type === "TEXT_MESSAGE_CONTENT"
          ? (record.delta ?? "")
          : ""
      })
      .join("")
    const fatal = chunks.find((chunk) => {
      const record = chunk as { type?: string }
      return record.type === "RUN_ERROR"
    })
    expect(fatal).toBeUndefined()
    expect(text).toContain("fallback-stub-ok")
    expect(upstreamHits.length).toBeGreaterThan(0)
    expect(
      upstreamHits.every((hit) => hit.model === "openai/gpt-5.6-terra"),
    ).toBe(true)
    expect(upstreamHits.some((hit) => hit.host.includes("anthropic"))).toBe(
      false,
    )
    expect(upstreamHits.some((hit) => hit.host.includes("openai.com"))).toBe(
      false,
    )
  })
})

function isolateHome(): void {
  const home = mkdtempSync(join(tmpdir(), "opencode-home-"))
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = join(home, "config")
  process.env.XDG_DATA_HOME = join(home, "data")
  process.env.XDG_STATE_HOME = join(home, "state")
  process.env.XDG_CACHE_HOME = join(home, "cache")
  mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true })
  delete process.env.OPENCODE_AUTH_CONTENT
}

function makeGitRepo(): { url: string; ref: string } {
  const dir = mkdtempSync(join(tmpdir(), "ws-live-"))
  execSync("git init -b main", { cwd: dir })
  writeFileSync(join(dir, "README.md"), "live workspace\n")
  execSync(
    "git add README.md && git -c user.email=live@ctxpipe.test -c user.name=live commit -m init",
    { cwd: dir },
  )
  const sha = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim()
  return { url: dir, ref: sha }
}

async function listenOpenAiStub(
  handler: (req: Request, url: URL) => Promise<unknown>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
      const request = new Request(url, {
        method: req.method,
        headers: req.headers as HeadersInit,
        body:
          req.method === "GET" || req.method === "HEAD"
            ? undefined
            : Buffer.concat(chunks),
      })
      const json = await handler(request, url)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(json))
    })()
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("expected tcp address")
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
