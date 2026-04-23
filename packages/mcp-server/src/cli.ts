#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  PingRequestSchema,
  type Result,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

const PassthroughResultSchema = z.unknown() as z.ZodType<Result>

function readEnv(name: string): string | undefined {
  const v = process.env[name]
  return v === "" || v === undefined ? undefined : v
}

function resolveRemoteUrl(): URL {
  const explicit = readEnv("CTXPIPE_MCP_URL")
  if (explicit) {
    try {
      return new URL(explicit)
    } catch {
      throw new Error(`CTXPIPE_MCP_URL is not a valid URL: ${explicit}`)
    }
  }

  const base = readEnv("CTXPIPE_BASE_URL") ?? "https://app.ctxpipe.ai"
  const orgSlug = readEnv("CTXPIPE_ORG_SLUG")
  if (!orgSlug) {
    throw new Error(
      "Set CTXPIPE_ORG_SLUG (organisation slug) or CTXPIPE_MCP_URL (full MCP endpoint URL). " +
        "Example: CTXPIPE_ORG_SLUG=my-org npx -y @ctxpipe/mcp-server",
    )
  }

  let u: URL
  try {
    u = new URL("/mcp", base.endsWith("/") ? base.slice(0, -1) : base)
  } catch {
    throw new Error(`CTXPIPE_BASE_URL is not a valid URL: ${base}`)
  }
  u.searchParams.set("orgSlug", orgSlug)
  return u
}

function buildRequestInit(): RequestInit | undefined {
  const token = readEnv("CTXPIPE_API_TOKEN")
  if (!token) return undefined
  return {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  }
}

async function main(): Promise<void> {
  const remoteUrl = resolveRemoteUrl()
  const requestInit = buildRequestInit()

  const upstream = new Client(
    { name: "@ctxpipe/mcp-server", version: "0.1.0" },
    { capabilities: {} },
  )

  const transport = new StreamableHTTPClientTransport(remoteUrl, {
    requestInit,
  })

  await upstream.connect(transport)

  const serverVersion = upstream.getServerVersion()
  const instructions = upstream.getInstructions()

  const facade = new Server(
    {
      name: serverVersion?.name ?? "ctxpipe",
      version: serverVersion?.version ?? "0.0.0",
    },
    {
      capabilities: upstream.getServerCapabilities() ?? {},
      ...(instructions !== undefined ? { instructions } : {}),
    },
  )

  facade.setRequestHandler(PingRequestSchema, async () => ({}))

  facade.setRequestHandler(ListToolsRequestSchema, async (req) => {
    return await upstream.request(req, PassthroughResultSchema)
  })

  facade.setRequestHandler(CallToolRequestSchema, async (req) => {
    return await upstream.request(req, PassthroughResultSchema)
  })

  facade.fallbackRequestHandler = async (request) => {
    return await upstream.request(request, PassthroughResultSchema)
  }

  const stdio = new StdioServerTransport()
  await facade.connect(stdio)

  const shutdown = async () => {
    try {
      await facade.close()
    } catch {
      /* ignore */
    }
    try {
      await upstream.close()
    } catch {
      /* ignore */
    }
    try {
      await transport.close()
    } catch {
      /* ignore */
    }
  }

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0))
  })
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0))
  })
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  const rpcError = {
    jsonrpc: "2.0" as const,
    error: {
      code: ErrorCode.InternalError,
      message,
    },
    id: null,
  }
  process.stderr.write(`${message}\n`)
  try {
    process.stdout.write(`${JSON.stringify(rpcError)}\n`)
  } catch {
    /* ignore */
  }
  if (err instanceof McpError) {
    process.exit(1)
  }
  process.exit(1)
})
