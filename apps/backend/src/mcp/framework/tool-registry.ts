import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

import { currentMcpActor } from "../../auth/context.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { applyAttribution } from "../../observability/attribution.js"
import { getLogger } from "../../observability/logger.js"
import { runMcpToolCall, setMcpOrgSlugHash } from "../correlation.js"
import { withInFlightLimit } from "./in-flight.js"
import { McpToolError } from "./tool-errors.js"
import { type CallOrg, requireToolOrg } from "./tool-org.js"
import { toolFailure, toolSuccess } from "./tool-result.js"

/** Every read tool has these annotations (ADR-051 §2). */
export const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies ToolAnnotations

export const orgArgument = z
  .string()
  .min(1)
  .max(64)
  .describe(
    "Org slug from the server instructions or list_workspaces. One org for each call.",
  )

type OrgMode = "required" | "optional"

type ToolInput<Shape extends z.ZodRawShape, Mode extends OrgMode> = z.infer<
  z.ZodObject<Shape>
> &
  (Mode extends "required" ? { org: string } : { org?: string })

type ToolContext<Mode extends OrgMode> = {
  /** The resolved org; null only when `org` is optional and omitted. */
  org: Mode extends "required" ? CallOrg : CallOrg | null
}

type McpReadToolDefinition<
  Shape extends z.ZodRawShape,
  Output extends z.ZodObject,
  Mode extends OrgMode,
> = {
  name: string
  title: string
  /** Under 1,000 characters, rule first. */
  description: string
  /** `required` on every tool except `list_workspaces`. */
  org: Mode
  /** Arguments other than `org`; the registry adds `org` first. */
  inputShape: Shape
  outputSchema: Output
  /** `_meta["anthropic/alwaysLoad"]`: the client loads the schema at once. */
  alwaysLoad?: boolean
  run(
    input: ToolInput<Shape, Mode>,
    context: ToolContext<Mode>,
  ): Promise<z.infer<Output>>
}

export type McpReadTool = {
  name: string
  register(server: McpServer): void
}

function principalKey(): string {
  const actor = currentMcpActor()
  return actor.type === "user"
    ? `user:${actor.userId}`
    : `org-service:${actor.orgId}`
}

/**
 * The steps that every read call shares: the in-flight limit of the
 * principal, then the org that `slug` names (null when there is no `slug`),
 * with its attribution. `fn` runs in the RLS context of the resolved org.
 * A read tool and a resource read both use it, so both enforce the same org
 * isolation.
 */
export function withCallOrg<T>(
  slug: string,
  fn: (org: CallOrg) => Promise<T>,
): Promise<T>
export function withCallOrg<T>(
  slug: undefined,
  fn: (org: null) => Promise<T>,
): Promise<T>
export function withCallOrg<T>(
  slug: string | undefined,
  fn: (org: CallOrg | null) => Promise<T>,
): Promise<T>
export function withCallOrg<T>(
  slug: string | undefined,
  fn: (org: never) => Promise<T>,
): Promise<T> {
  const run = fn as (org: CallOrg | null) => Promise<T>
  return withInFlightLimit(principalKey(), async () => {
    const org = slug === undefined ? null : await requireToolOrg(slug)
    // The org of this call, not the URL default (ADR-051 §9).
    if (org) {
      applyAttribution({
        "ctxpipe.org.id": org.id,
        "ctxpipe.org.slug": org.slug,
      })
      setMcpOrgSlugHash(org.slug)
    }
    return org ? withOrgIdContext(org, () => run(org)) : run(org)
  })
}

/**
 * One read tool. The registry adds correlation (`runMcpToolCall`: span,
 * attributes, `_meta["ai.ctxpipe/callId"]`), checks the in-flight limit, resolves `org`,
 * runs the tool in the RLS context of that org, and maps errors to
 * `{ code, message, retryable }` results.
 */
export function defineMcpReadTool<
  Shape extends z.ZodRawShape,
  Output extends z.ZodObject,
  Mode extends OrgMode,
>(definition: McpReadToolDefinition<Shape, Output, Mode>): McpReadTool {
  const inputSchema = z.object({
    org: definition.org === "required" ? orgArgument : orgArgument.optional(),
    ...definition.inputShape,
  })
  const call = async (
    args: Record<string, unknown>,
  ): Promise<CallToolResult> => {
    try {
      const slug = typeof args.org === "string" ? args.org : undefined
      const output = await withCallOrg(slug, async (org) => {
        const input = args as ToolInput<Shape, Mode>
        const context = { org } as ToolContext<Mode>
        return definition.run(input, context)
      })
      return toolSuccess(output as Record<string, unknown>)
    } catch (error) {
      if (error instanceof McpToolError) return toolFailure(error)
      getLogger().error(
        error instanceof Error ? error : new Error(String(error)),
        { step: "mcp.tool", mcp: { tool: definition.name } },
      )
      return toolFailure(
        new McpToolError(
          "internal",
          "ctxpipe could not complete the call. Try again.",
        ),
      )
    }
  }
  return {
    name: definition.name,
    register(server) {
      server.registerTool(
        definition.name,
        {
          title: definition.title,
          description: definition.description,
          inputSchema,
          outputSchema: definition.outputSchema,
          annotations: READ_TOOL_ANNOTATIONS,
          ...(definition.alwaysLoad
            ? { _meta: { "anthropic/alwaysLoad": true } }
            : {}),
        },
        (args: Record<string, unknown>, extra) =>
          runMcpToolCall({ toolName: definition.name, extra }, () =>
            call(args),
          ),
      )
    },
  }
}

/** Register the tools in list order, so `tools/list` order is stable. */
export function registerMcpReadTools(
  server: McpServer,
  tools: readonly McpReadTool[],
): void {
  const names = new Set<string>()
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`MCP tool ${tool.name} is registered twice`)
    }
    names.add(tool.name)
    tool.register(server)
  }
}
