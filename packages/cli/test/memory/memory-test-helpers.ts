import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { JsonRpcRequest, ToolResult } from "../../src/memory/mcp-server.js"
import { POLICY, type PolicyAction } from "../../src/memory/policy.js"

export const FAKE_AGENTMEMORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-agentmemory.cjs",
)

export function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function jsonRpc(
  id: number,
  method: string,
  params?: unknown,
): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params }
}

export function getToolResult(response: unknown): ToolResult {
  const r = response as {
    result?: { content?: ToolResult["content"]; isError?: boolean }
  }
  return {
    content: r.result?.content ?? [],
    isError: r.result?.isError ?? false,
  }
}

export function toolPayload(result: ToolResult): unknown {
  return JSON.parse(result.content[0]?.text ?? "{}")
}

export function seedRepoConfig(
  cwd: string,
  opts: { orgSlug?: string; baseUrl?: string } = {},
): void {
  mkdirSync(join(cwd, ".ctxpipe"), { recursive: true })
  writeFileSync(
    join(cwd, ".ctxpipe", "config.json"),
    JSON.stringify({
      orgSlug: opts.orgSlug ?? "acme",
      baseUrl: opts.baseUrl ?? "http://127.0.0.1:0",
      memory: {
        provider: "agentmemory",
        enabled: true,
        memoryRoot: ".ai/memory",
      },
    }),
    "utf8",
  )
}

export function seedMarkdown(
  cwd: string,
  records: Array<{
    id: string
    type: string
    body: string
    concepts?: string[]
    files?: string[]
  }>,
): void {
  for (const r of records) {
    const dir = join(cwd, ".ai", "memory", r.type)
    mkdirSync(dir, { recursive: true })
    const filesYaml =
      r.files && r.files.length > 0
        ? `files:\n${r.files.map((f) => `  - ${f}`).join("\n")}\n`
        : "files: []\n"
    const concepts = (r.concepts ?? []).join(", ")
    const content = `---\nid: ${r.id}\ntype: ${r.type}\nconcepts: [${concepts}]\n${filesYaml}createdAt: 2026-05-25T00:00:00.000Z\nupdatedAt: 2026-05-25T00:00:00.000Z\n---\n# ${r.id}\n${r.body}\n`
    writeFileSync(join(dir, `${r.id}.md`), content, "utf8")
  }
}

export function assertCanonicalFile(
  cwd: string,
  opts: {
    id: string
    type: string
    bodyContains?: string
    concepts?: string[]
    files?: string[]
  },
): void {
  const file = join(cwd, ".ai", "memory", opts.type, `${opts.id}.md`)
  if (!existsSync(file)) {
    throw new Error(`expected canonical memory file at ${file}`)
  }
  const text = readFileSync(file, "utf8")
  if (!text.includes(`id: ${opts.id}`)) {
    throw new Error(`missing id frontmatter in ${file}`)
  }
  if (opts.bodyContains && !text.includes(opts.bodyContains)) {
    throw new Error(`body missing "${opts.bodyContains}" in ${file}`)
  }
  for (const concept of opts.concepts ?? []) {
    if (!text.includes(concept)) {
      throw new Error(`missing concept "${concept}" in ${file}`)
    }
  }
  for (const filePath of opts.files ?? []) {
    if (!text.includes(filePath)) {
      throw new Error(`missing file path "${filePath}" in ${file}`)
    }
  }
}

export function visiblePolicyToolNames(): string[] {
  return Object.entries(POLICY)
    .filter(([, action]) => action !== "hide")
    .map(([name]) => name)
    .sort()
}

export type FakeRequestEntry = {
  method: string
  path: string
  bodySummary: unknown
  at: string
}

export async function fetchFakeRequests(
  baseUrl: string,
  secret?: string,
): Promise<FakeRequestEntry[]> {
  const headers: Record<string, string> = {}
  if (secret) headers.authorization = `Bearer ${secret}`
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/__test/requests`, {
    headers,
  })
  if (!res.ok) {
    throw new Error(`fetchFakeRequests failed: ${res.status}`)
  }
  const json = (await res.json()) as { requests: FakeRequestEntry[] }
  return json.requests
}

export async function resetFakeRequests(
  baseUrl: string,
  secret?: string,
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (secret) headers.authorization = `Bearer ${secret}`
  const res = await fetch(
    `${baseUrl.replace(/\/$/, "")}/__test/requests/reset`,
    { method: "POST", headers },
  )
  if (!res.ok) {
    throw new Error(`resetFakeRequests failed: ${res.status}`)
  }
}

export function importCalls(requests: FakeRequestEntry[]): FakeRequestEntry[] {
  return requests.filter((r) => r.path.startsWith("/agentmemory/import"))
}

export async function spawnFakeAgentMemory(): Promise<{
  url: string
  secret: string | undefined
  child: ChildProcess
}> {
  const port = await freePort()
  const secret = "test-secret-" + port
  const child = spawn(process.execPath, [FAKE_AGENTMEMORY], {
    env: {
      ...process.env,
      III_REST_PORT: String(port),
      AGENTMEMORY_SECRET: secret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("fake agentmemory did not start in time")),
      8_000,
    )
    const onData = (chunk: Buffer) => {
      if (String(chunk).includes("fake-agentmemory listening")) {
        clearTimeout(timer)
        child.stdout?.off("data", onData)
        resolve()
      }
    }
    child.stdout?.on("data", onData)
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
  return { url: `http://127.0.0.1:${port}`, secret, child }
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const net = require("node:net") as typeof import("node:net")
    const srv = net.createServer()
    srv.unref()
    srv.on("error", rej)
    srv.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = srv.address()
      if (address && typeof address === "object") {
        const port = address.port
        srv.close(() => res(port))
      } else {
        srv.close()
        rej(new Error("could not allocate port"))
      }
    })
  })
}

export type PolicyActionName = PolicyAction
