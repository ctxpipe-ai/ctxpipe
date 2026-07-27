import { existsSync } from "node:fs"
import {
  buildImportPayload,
  buildManifestFromScan,
  classifyDelta,
  readManifest,
  scanMemoryTree,
  searchCanonical,
  writeCanonicalRecord,
  writeManifest,
  type DeltaClassification,
} from "./hydration.js"
import { detectRepoFingerprint, resolveMemoryRoot } from "./paths.js"
import {
  POLICY,
  type PolicyAction,
  toolSpec,
  type ToolSpec,
} from "./policy.js"
import {
  PINNED_AGENTMEMORY_VERSION,
  createSupervisor,
  type Supervisor,
} from "./supervisor.js"
import {
  agentMemorySearch,
  agentMemoryImport,
} from "./agentmemory-client.js"
import { ensureFreshAccessToken, readStoredCtxpipeConfig } from "../auth.js"

export type McpServerOptions = {
  baseUrl: string
  /** Override for tests. */
  cwd?: string
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
  /** Pre-built supervisor for tests (skips real AgentMemory spawn). */
  supervisor?: Supervisor
  /** Disable lazy spawn entirely (signed-out / no-runtime mode). */
  startSupervisor?: boolean
}

export type ToolCallContext = {
  baseUrl: string
  cwd: string
  fingerprint: string
  orgSlug: string | null
  signedIn: boolean
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

/** Build the JSON-RPC interface but don't bind to stdio yet — used by tests. */
export function createMcpServer(opts: McpServerOptions): {
  handle: (request: JsonRpcRequest) => Promise<JsonRpcResponse | null>
  context: () => Promise<ToolCallContext>
} {
  const cwd = opts.cwd ?? process.cwd()
  let supervisor: Supervisor | null = opts.supervisor ?? null
  let cachedCtx: ToolCallContext | null = null

  async function context(): Promise<ToolCallContext> {
    if (cachedCtx) return cachedCtx
    const fingerprint = detectRepoFingerprint(cwd)
    const config = readStoredCtxpipeConfig(cwd)
    const fresh = await ensureFreshAccessToken({ baseUrl: opts.baseUrl }).catch(
      () => null,
    )
    cachedCtx = {
      baseUrl: opts.baseUrl,
      cwd,
      fingerprint,
      orgSlug: config?.orgSlug ?? null,
      signedIn: Boolean(fresh),
    }
    return cachedCtx
  }

  async function getSupervisor(): Promise<Supervisor | null> {
    if (supervisor) return supervisor
    if (opts.startSupervisor === false) return null
    if (process.env.CTXPIPE_MEMORY_DISABLE_SUPERVISOR === "1") return null
    const ctx = await context()
    const cmdOverride = process.env.CTXPIPE_MEMORY_AGENTMEMORY_COMMAND
    supervisor = createSupervisor({
      fingerprint: ctx.fingerprint,
      command: cmdOverride
        ? {
            command: cmdOverride,
            args: (process.env.CTXPIPE_MEMORY_AGENTMEMORY_ARGS ?? "")
              .split("\n")
              .filter((arg) => arg.length > 0),
          }
        : undefined,
      getAccessToken: ctx.signedIn
        ? async () => {
            const fresh = await ensureFreshAccessToken({ baseUrl: opts.baseUrl })
            return fresh?.accessToken ?? null
          }
        : undefined,
      openaiBaseUrl:
        ctx.signedIn && ctx.orgSlug
          ? `${opts.baseUrl}/${ctx.orgSlug}/api/v1/openai`
          : undefined,
    })
    return supervisor
  }

  async function ensureHydrated(): Promise<{
    classification: DeltaClassification
    sup: Supervisor | null
  }> {
    const ctx = await context()
    const memoryRoot = resolveMemoryRoot(ctx.cwd)
    const scan = scanMemoryTree(memoryRoot)
    const manifest = readManifest(ctx.fingerprint)
    const classification = classifyDelta({ manifest, scan })
    if (classification.kind === "refuse") {
      return { classification, sup: null }
    }
    if (classification.kind === "noop") {
      return { classification, sup: await getSupervisor() }
    }
    const sup = await getSupervisor()
    if (sup) {
      try {
        const runtime = await sup.ensureRunning()
        await agentMemoryImport({
          url: runtime.url,
          secret: runtime.secret ?? process.env.AGENTMEMORY_SECRET,
          payload: buildImportPayload({
            strategy: classification.kind === "large" ? "replace" : "merge",
            records: scan.records,
            deletedIds:
              classification.kind === "small" || classification.kind === "large"
                ? classification.deletedMemoryIds
                : [],
            agentmemoryVersion: PINNED_AGENTMEMORY_VERSION,
          }),
        })
      } catch {
        // proceed with Markdown fallback
      }
    }
    writeManifest(
      ctx.fingerprint,
      buildManifestFromScan({
        scan,
        memoryRoot: ".ai/memory",
        fingerprint: ctx.fingerprint,
        agentmemoryVersion: PINNED_AGENTMEMORY_VERSION,
      }),
    )
    return { classification, sup }
  }

  async function callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const action: PolicyAction | undefined = POLICY[name]
    if (!action || action === "hide") {
      return {
        isError: true,
        content: [{ type: "text", text: `tool not available: ${name}` }],
      }
    }
    const ctx = await context()

    if (action === "ctxpipe-native" && name === "memory_status") {
      const supervisor = await getSupervisor()
      const runtime = supervisor?.current() ?? null
      return jsonResult({
        signedIn: ctx.signedIn,
        orgSlug: ctx.orgSlug,
        runtime,
        hostedModel: ctx.signedIn ? "available" : "signed-out",
        memoryRoot: resolveMemoryRoot(ctx.cwd),
        memoryRootExists: existsSync(resolveMemoryRoot(ctx.cwd)),
      })
    }

    if (action === "gate-hosted-model" && !ctx.signedIn) {
      return jsonResult({
        status: "enhanced-memory-unavailable",
        reason: "signed-out",
        message:
          "Enhanced memory summaries need ctxpipe auth login. Local memory is still running. Run `npx ctxpipe auth login` to enable hosted summaries and consolidation.",
      })
    }

    if (action === "write-markdown-then-hydrate" && name === "memory_save") {
      const input = parseSaveInput(args)
      writeCanonicalRecord({ cwd: ctx.cwd, input })
      const hyd = await ensureHydrated()
      if (hyd.classification.kind === "refuse") {
        return refuseAsResult(hyd.classification)
      }
      return jsonResult({
        status: "saved",
        id: input.id,
        repoId: ctx.fingerprint,
        orgSlug: ctx.orgSlug,
      })
    }

    if (
      action === "hydrate-then-query-or-markdown-fallback" &&
      (name === "memory_recall" || name === "memory_smart_search")
    ) {
      const query = String(args.query ?? args.q ?? "").trim()
      if (!query) {
        return jsonResult({ matches: [] })
      }
      const hyd = await ensureHydrated()
      if (hyd.classification.kind === "refuse") {
        return refuseAsResult(hyd.classification)
      }
      const supervisor = await getSupervisor()
      const runtime = supervisor?.current() ?? null
      if (runtime) {
        try {
          const remote = await agentMemorySearch({
            url: runtime.url,
            secret: runtime.secret ?? process.env.AGENTMEMORY_SECRET,
            query,
            project: ctx.orgSlug ?? "",
            cwd: ctx.cwd,
            limit: Number(args.limit ?? 10),
          })
          return jsonResult({ matches: remote, source: "agentmemory" })
        } catch {
          // fall through
        }
      }
      const memoryRoot = resolveMemoryRoot(ctx.cwd)
      const scan = scanMemoryTree(memoryRoot)
      const ranked = searchCanonical(scan.records, query, Number(args.limit ?? 10))
      return jsonResult({
        matches: ranked.map(({ record, score }) => ({
          id: record.id,
          type: record.type,
          title: record.title,
          content: record.body,
          concepts: record.concepts,
          files: record.files,
          score,
        })),
        source: "markdown-fallback",
      })
    }

    return {
      isError: true,
      content: [{ type: "text", text: `unhandled tool action ${action} for ${name}` }],
    }
  }

  async function listTools(): Promise<ToolSpec[]> {
    return Object.entries(POLICY)
      .filter(([, action]) => action !== "hide")
      .map(([name]) => toolSpec(name))
  }

  return {
    context,
    async handle(request) {
      if (request.method === "initialize") {
        return jsonRpcResult(request.id, {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "ctxpipe-memory", version: PINNED_AGENTMEMORY_VERSION },
          capabilities: { tools: {} },
        })
      }
      if (request.method === "notifications/initialized") {
        return null
      }
      if (request.method === "tools/list") {
        return jsonRpcResult(request.id, { tools: await listTools() })
      }
      if (request.method === "tools/call") {
        const params = (request.params ?? {}) as {
          name?: string
          arguments?: Record<string, unknown>
        }
        if (!params.name) {
          return jsonRpcError(request.id, -32602, "missing tool name")
        }
        try {
          const result = await callTool(params.name, params.arguments ?? {})
          return jsonRpcResult(request.id, result)
        } catch (err) {
          return jsonRpcError(
            request.id,
            -32000,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
      if (request.method === "ping") {
        return jsonRpcResult(request.id, {})
      }
      return jsonRpcError(request.id, -32601, `method not found: ${request.method}`)
    },
  }
}

export async function startMcpServer(opts: McpServerOptions): Promise<void> {
  const server = createMcpServer(opts)
  const stdin = opts.stdin ?? process.stdin
  const stdout = opts.stdout ?? process.stdout
  let buffer = ""
  await new Promise<void>((resolve) => {
    const input = stdin as NodeJS.EventEmitter & {
      setEncoding?: (enc: string) => void
    }
    input.setEncoding?.("utf8")
    input.on("data", (chunk: string | Buffer) => {
      buffer += String(chunk)
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.length > 0) {
          handleLine(line)
        }
        newline = buffer.indexOf("\n")
      }
    })
    input.on("end", () => resolve())
    input.on("close", () => resolve())
  })

  function handleLine(line: string): void {
    let request: JsonRpcRequest
    try {
      request = JSON.parse(line) as JsonRpcRequest
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: `Parse error: ${message}` },
        })}\n`,
      )
      return
    }
    server
      .handle(request)
      .then((response) => {
        if (response) {
          stdout.write(`${JSON.stringify(response)}\n`)
        }
      })
      .catch((err) => {
        stdout.write(
          `${JSON.stringify(
            jsonRpcError(
              request.id ?? null,
              -32000,
              err instanceof Error ? err.message : String(err),
            ),
          )}\n`,
        )
      })
  }
}

export type JsonRpcRequest = {
  jsonrpc?: "2.0"
  id?: string | number | null
  method: string
  params?: unknown
}

export type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

function jsonRpcResult(
  id: JsonRpcRequest["id"],
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result }
}

function jsonRpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }
}

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

function refuseAsResult(classification: DeltaClassification & { kind: "refuse" }): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "hydration-refused",
          reason: classification.reason,
          details: classification.details,
        }),
      },
    ],
  }
}

function parseSaveInput(args: Record<string, unknown>): {
  id: string
  type: string
  title: string
  body: string
  concepts?: string[]
  files?: string[]
} {
  const id = String(args.id ?? "").trim()
  if (!id) throw new Error("memory_save: `id` is required")
  const type = String(args.type ?? "note").trim() || "note"
  const title = String(args.title ?? id).trim()
  const body = String(args.body ?? args.content ?? "").trim()
  if (!body) throw new Error("memory_save: `body` (or `content`) is required")
  const concepts = Array.isArray(args.concepts)
    ? args.concepts.map((value) => String(value))
    : []
  const files = Array.isArray(args.files)
    ? args.files.map((value) => String(value))
    : []
  return { id, type, title, body, concepts, files }
}
