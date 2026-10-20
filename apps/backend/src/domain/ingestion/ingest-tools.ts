import { createToolBridgeCore, handleBridgeJsonRpc } from "@tanstack/ai-sandbox"
import { and, eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import {
  repositoryRevisionCheckoutKey,
  workspaceCheckoutKey,
} from "../../../../../shared/workspace-checkout.js"
import type { AppEnv } from "../../app/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { toToon } from "../../lib/agentToolRuntime.js"
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
  parseCodeToolArgs,
  repositoryIdFromToolArgs,
  runCodeTool,
  stringArg,
} from "../workspaces/code-tools.js"
import {
  verifyWorkspaceIngestToolsCapability,
  type WorkspaceIngestToolsClaims,
} from "../workspaces/workspace-chat-run-capability.js"
import { workspaceChatBearerToken } from "../workspaces/workspace-chat-token.js"
import type { WorkspaceChatTanstackTool } from "../workspaces/workspace-chat-tools.js"

/**
 * The ingest tool bridge (ADR-052 section 7): the shared codesearch tools,
 * bound read-only to the checkouts of the step's `workspace-ingest-tools`
 * capability (T03): the source at `rev:<sha>` and the destination Workspace
 * repositories at `ws:<workspaceId>:<sha>`.
 *
 * The capability is valid while its step holds the shard lock of an
 * unfinished run, so the next step, `destroy-sandbox`, and a cancelled run
 * end it. The route keeps no state in memory: each replica can serve a call.
 */
export const INGEST_TOOL_BRIDGE_PATH = "/api/v1/workspace-ingest/tool-bridge"

type BoundCheckout = WorkspaceIngestToolsClaims["checkouts"][number]

/** The checkout that a claimed key names, or null for an unknown key. */
function codeCheckout(bound: BoundCheckout): CodeCheckout | null {
  const { repositoryId, checkoutKey, sha } = bound
  if (checkoutKey === repositoryRevisionCheckoutKey(sha))
    return { repositoryId, source: { sha } }
  const workspaceId = /^ws:([a-zA-Z0-9_-]+):/.exec(checkoutKey)?.[1]
  if (workspaceId && checkoutKey === workspaceCheckoutKey(workspaceId, sha))
    return { repositoryId, workspace: { workspaceId, sha } }
  return null
}

/** True when each claimed repository is a repository of `orgId`. */
async function repositoriesOfOrg(
  orgId: string,
  repositoryIds: ReadonlySet<string>,
): Promise<boolean> {
  const rows = await withOrgDbContext(orgId, (db) =>
    db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.orgId, orgId),
          inArray(repositories.id, [...repositoryIds]),
        ),
      ),
  )
  return rows.length === repositoryIds.size
}

const LIST_CHECKOUTS_DEFINITION: Omit<WorkspaceChatTanstackTool, "execute"> = {
  name: "list_checkouts",
  description:
    "List the codesearch checkouts of this run: the source repository and the repositories of each destination Workspace. Give repositoryId and checkoutKey from this list to every other tool.",
  inputSchema: { type: "object", properties: {} },
}

/** The step's tools. Each call must name a bound repository and checkout key. */
function ingestTools(
  orgId: string,
  checkouts: ReadonlyArray<BoundCheckout & { checkout: CodeCheckout }>,
): WorkspaceChatTanstackTool[] {
  const bound = new Map(
    checkouts.map((item) => [
      `${item.repositoryId}\n${item.checkoutKey}`,
      item.checkout,
    ]),
  )
  const listCheckouts: WorkspaceChatTanstackTool = {
    ...LIST_CHECKOUTS_DEFINITION,
    execute: async () =>
      toToon({
        checkouts: checkouts.map(({ repositoryId, checkoutKey, checkout }) => ({
          repositoryId,
          checkoutKey,
          ...("workspace" in checkout
            ? {
                role: "workspace",
                workspaceId: checkout.workspace.workspaceId,
              }
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
            checkoutKey: {
              type: "string",
              minLength: 1,
              description: "Checkout key from list_checkouts",
            },
          },
          required: [...(definition.inputSchema.required ?? []), "checkoutKey"],
        },
        execute: async (args, execution) => {
          execution?.abortSignal?.throwIfAborted()
          const { checkoutKey: _key, ...toolArgs } =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {}
          const parsed = parseCodeToolArgs(tool.name, toolArgs)
          if ("error" in parsed) return parsed.error
          const repositoryId = repositoryIdFromToolArgs(args)
          const checkoutKey = stringArg(args, "checkoutKey")
          const checkout = bound.get(`${repositoryId}\n${checkoutKey}`)
          if (!checkout)
            return toToon({
              error: "checkout_not_in_run",
              repositoryId,
              checkoutKey: checkoutKey || null,
            })
          const workspace =
            "workspace" in checkout && "sha" in checkout.workspace
              ? checkout.workspace
              : undefined
          return runCodeTool({
            toolName: tool.name,
            args: parsed.args,
            orgId,
            checkout,
            search: async (query, detail) => {
              const result = await zoektSearchRepository(
                { id: checkout.repositoryId, orgId },
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
export const ingestToolBridgeRoutes = new Hono<AppEnv>()
  .post(INGEST_TOOL_BRIDGE_PATH, async (c) => {
    const token = workspaceChatBearerToken(c.req.header("authorization"))
    const claims = token
      ? await verifyWorkspaceIngestToolsCapability({
          authSecret: c.var.env.AUTH_SECRET,
          token,
        })
      : undefined
    if (!claims) return c.text("unauthorized", 401)
    const checkouts = claims.checkouts.map((item) => ({
      ...item,
      checkout: codeCheckout(item),
    }))
    if (
      checkouts.some((item) => !item.checkout) ||
      !(await repositoriesOfOrg(
        claims.orgId,
        new Set(checkouts.map((item) => item.repositoryId)),
      ))
    )
      return c.text("forbidden", 403)
    let message: unknown
    try {
      message = await c.req.json()
    } catch {
      return c.text("invalid JSON body", 400)
    }
    const core = createToolBridgeCore(
      ingestTools(
        claims.orgId,
        checkouts.flatMap(({ checkout, ...item }) =>
          checkout ? [{ ...item, checkout }] : [],
        ),
      ),
      { signal: c.req.raw.signal },
    )
    const response = await handleBridgeJsonRpc(core, message)
    return response === null ? c.body(null, 202) : c.json(response)
  })
  // The MCP client opens a GET stream. Without this route, the request goes
  // on to the session routes, and their 401 starts OAuth in the client.
  .get(INGEST_TOOL_BRIDGE_PATH, (c) => c.text("method not allowed", 405))
