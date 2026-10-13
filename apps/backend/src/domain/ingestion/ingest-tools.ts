import { createHmac, timingSafeEqual } from "node:crypto"
import { createToolBridgeCore, handleBridgeJsonRpc } from "@tanstack/ai-sandbox"
import { Hono } from "hono"
import { z } from "zod"
import {
  repositoryRevisionCheckoutKey,
  workspaceCheckoutKey,
} from "../../../../../shared/workspace-checkout.js"
import { toToon } from "../../lib/agentToolRuntime.js"
import { getSandboxInstance } from "../../models/workspaces.js"
import {
  isZoektSearchClientFailure,
  zoektSearchRepository,
} from "../../tools/codesearchZoekt.js"
import {
  COMPACT_SEARCH_OPTS,
  FULL_SEARCH_OPTS,
} from "../../tools/zoektCompact.js"
import {
  CODE_TOOLS,
  type CodeCheckout,
  explorerToolDefinition,
  repositoryIdFromToolArgs,
  runCodeTool,
  stringArg,
} from "../workspaces/code-tools.js"
import { ingestSandboxThreadId } from "../workspaces/ingest-sandbox.js"
import { workspaceChatBearerToken } from "../workspaces/workspace-chat-token.js"
import type { WorkspaceChatTanstackTool } from "../workspaces/workspace-chat-tools.js"

/**
 * The ingest tool bridge (ADR-052 section 7): the shared codesearch tools,
 * bound read-only to the run's source checkout (`rev:<sha>`) and to the
 * destination Workspace checkouts (`ws:<workspaceId>:<sha>`).
 *
 * The bearer token is run-scoped and signed by the host. It is valid only
 * while the shard's ingest sandbox row exists, so `destroy-sandbox` (or the
 * org sweep) revokes it. The route keeps no state in memory, so any backend
 * replica can serve a call.
 */
export const INGEST_TOOL_BRIDGE_PATH = "/api/v1/workspace-ingest/tool-bridge"

const TOKEN_MAX_LENGTH = 16_384
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

const BoundCheckoutSchema = z.object({
  repositoryId: z.string().regex(/^repo_/),
  sha: z.string().regex(SHA),
  /** Absent for the source checkout. */
  workspaceId: z.string().min(1).optional(),
})

const IngestToolClaimsSchema = z.object({
  version: z.literal(1),
  purpose: z.literal("workspace-ingest-tools"),
  orgId: z.string().min(1),
  runId: z.string().min(1),
  shard: z.number().int().nonnegative(),
  sandboxKey: z.string().min(1),
  checkouts: z.array(BoundCheckoutSchema).max(64),
})

export type IngestToolClaims = z.infer<typeof IngestToolClaimsSchema>
type BoundCheckout = z.infer<typeof BoundCheckoutSchema>

function checkoutKeyOf(checkout: BoundCheckout): string {
  return checkout.workspaceId
    ? workspaceCheckoutKey(checkout.workspaceId, checkout.sha)
    : repositoryRevisionCheckoutKey(checkout.sha)
}

function sign(encodedPayload: string, authSecret: string): string {
  return createHmac("sha256", authSecret)
    .update(encodedPayload)
    .digest("base64url")
}

/** The shard's sandbox row exists: the run has not passed `destroy-sandbox`. */
async function shardSandboxIsLive(claims: {
  orgId: string
  runId: string
  shard: number
  sandboxKey: string
}): Promise<boolean> {
  const row = await getSandboxInstance(claims.sandboxKey, claims.orgId)
  return (
    row?.kind === "ingest" &&
    row.conversationId === ingestSandboxThreadId(claims.runId, claims.shard)
  )
}

/**
 * Mint the run's bridge token after `ensure-sandbox`. The checkouts are the
 * source at its pinned SHA and each destination Workspace's repositories at
 * their pinned SHAs.
 */
export async function mintIngestToolToken(input: {
  authSecret: string
  orgId: string
  runId: string
  shard: number
  sandboxKey: string
  source: { repositoryId: string; sha: string }
  destinations: ReadonlyArray<{
    workspaceId: string
    repositories: ReadonlyArray<{ repositoryId: string; sha: string }>
  }>
}): Promise<string> {
  const claims = IngestToolClaimsSchema.parse({
    version: 1,
    purpose: "workspace-ingest-tools",
    orgId: input.orgId,
    runId: input.runId,
    shard: input.shard,
    sandboxKey: input.sandboxKey,
    checkouts: [
      { repositoryId: input.source.repositoryId, sha: input.source.sha },
      ...input.destinations.flatMap((destination) =>
        destination.repositories.map((repository) => ({
          repositoryId: repository.repositoryId,
          sha: repository.sha,
          workspaceId: destination.workspaceId,
        })),
      ),
    ],
  })
  // Validates each Workspace id and SHA before the token exists.
  for (const checkout of claims.checkouts) checkoutKeyOf(checkout)
  if (!(await shardSandboxIsLive(claims)))
    throw new Error("The ingest shard has no live sandbox for a tool token")
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString(
    "base64url",
  )
  return `${encodedPayload}.${sign(encodedPayload, input.authSecret)}`
}

/** The claims of a valid token whose shard sandbox still exists, else undefined. */
export async function verifyIngestToolToken(input: {
  authSecret: string
  token: string
}): Promise<IngestToolClaims | undefined> {
  if (input.token.length === 0 || input.token.length > TOKEN_MAX_LENGTH)
    return undefined
  const [encodedPayload, signature, extra] = input.token.split(".")
  if (!encodedPayload || !signature || extra !== undefined) return undefined
  const expected = Buffer.from(sign(encodedPayload, input.authSecret))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return undefined
  let claims: IngestToolClaims
  try {
    claims = IngestToolClaimsSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
    )
  } catch {
    return undefined
  }
  return (await shardSandboxIsLive(claims)) ? claims : undefined
}

const CHECKOUT_KEY_SCHEMA = {
  type: "string",
  minLength: 1,
  description: "Checkout key from list_checkouts (rev:<sha> or ws:<id>:<sha>)",
} as const

const LIST_CHECKOUTS_DEFINITION: Omit<WorkspaceChatTanstackTool, "execute"> = {
  name: "list_checkouts",
  description:
    "List the codesearch checkouts of this run: the source repository and the repositories of each destination Workspace. Give repositoryId and checkoutKey from this list to every other tool.",
  inputSchema: { type: "object", properties: {} },
}

/** The run's tools. Each call must name a bound repository and checkout key. */
export function ingestTools(
  claims: Pick<IngestToolClaims, "orgId" | "checkouts">,
): WorkspaceChatTanstackTool[] {
  const bound = new Map(
    claims.checkouts.map((checkout) => [
      `${checkout.repositoryId}\n${checkoutKeyOf(checkout)}`,
      checkout,
    ]),
  )
  const listCheckouts: WorkspaceChatTanstackTool = {
    ...LIST_CHECKOUTS_DEFINITION,
    execute: async () =>
      toToon({
        checkouts: claims.checkouts.map((checkout) => ({
          repositoryId: checkout.repositoryId,
          checkoutKey: checkoutKeyOf(checkout),
          ...(checkout.workspaceId
            ? { role: "workspace", workspaceId: checkout.workspaceId }
            : { role: "source" }),
        })),
      }),
  }
  return [
    listCheckouts,
    ...CODE_TOOLS.map((tool): WorkspaceChatTanstackTool => {
      const definition = explorerToolDefinition(
        tool,
        "Uses the codesearch checkout that checkoutKey names.",
      )
      return {
        name: definition.name,
        description: `${definition.description}\nAlso give checkoutKey from list_checkouts.`,
        inputSchema: {
          ...definition.inputSchema,
          type: "object",
          properties: {
            ...definition.inputSchema.properties,
            checkoutKey: CHECKOUT_KEY_SCHEMA,
          },
          required: [...(definition.inputSchema.required ?? []), "checkoutKey"],
        },
        execute: async (args, execution) => {
          execution?.abortSignal?.throwIfAborted()
          const repositoryId = repositoryIdFromToolArgs(args)
          const checkoutKey = stringArg(args, "checkoutKey")
          const checkout = bound.get(`${repositoryId}\n${checkoutKey}`)
          if (!repositoryId || !checkout)
            return toToon({
              error: "checkout_not_in_run",
              repositoryId,
              checkoutKey: checkoutKey || null,
            })
          const { checkoutKey: _key, ...toolArgs } = args as Record<
            string,
            unknown
          >
          const workspace = checkout.workspaceId
            ? { workspaceId: checkout.workspaceId, sha: checkout.sha }
            : undefined
          const target: CodeCheckout = workspace
            ? { repositoryId, workspace }
            : { repositoryId, source: { sha: checkout.sha } }
          return runCodeTool({
            toolName: tool.name,
            args: toolArgs,
            orgId: claims.orgId,
            checkout: target,
            search: async (query, detail) => {
              const result = await zoektSearchRepository(
                { id: repositoryId, orgId: claims.orgId },
                query,
                detail === "full" ? FULL_SEARCH_OPTS : COMPACT_SEARCH_OPTS,
                workspace,
              )
              if (isZoektSearchClientFailure(result))
                throw new Error(
                  `search failed with status ${result.status}: ${result.error}`,
                )
              return result
            },
          })
        },
      }
    }),
  ]
}

/** Stateless MCP over HTTP for ingest sandboxes: JSON-RPC in, JSON out. */
export const ingestToolBridgeRoutes = new Hono()
  .post(INGEST_TOOL_BRIDGE_PATH, async (c) => {
    const token = workspaceChatBearerToken(c.req.header("authorization"))
    const authSecret = process.env.AUTH_SECRET?.trim()
    const claims =
      token && authSecret
        ? await verifyIngestToolToken({ authSecret, token })
        : undefined
    if (!claims) return c.text("unauthorized", 401)
    let message: unknown
    try {
      message = await c.req.json()
    } catch {
      return c.text("invalid JSON body", 400)
    }
    const core = createToolBridgeCore(ingestTools(claims), {
      signal: c.req.raw.signal,
    })
    const response = await handleBridgeJsonRpc(core, message)
    return response === null ? c.body(null, 202) : c.json(response)
  })
  .get(INGEST_TOOL_BRIDGE_PATH, (c) => c.text("method not allowed", 405))
