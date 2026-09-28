import { and, isNull, or, sql } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import { orgOnboarding } from "../db/schema/org_onboarding.js"

/**
 * Keeps the first MCP call, client and tool an org's agents send. Later
 * calls fill a missing client or tool and never overwrite one, and the
 * `setWhere` skips the write once all three are known.
 */
export async function recordFirstMcpCall(input: {
  orgId: string
  clientName?: string
  toolName?: string
}): Promise<void> {
  const firstMcpClient = input.clientName ?? null
  const firstMcpTool = input.toolName ?? null
  await getSystemDb()
    .insert(orgOnboarding)
    .values({
      organizationId: input.orgId,
      firstMcpCallAt: new Date(),
      firstMcpClient,
      firstMcpTool,
    })
    .onConflictDoUpdate({
      target: orgOnboarding.organizationId,
      set: {
        firstMcpCallAt: sql`coalesce(${orgOnboarding.firstMcpCallAt}, excluded.first_mcp_call_at)`,
        firstMcpClient: sql`coalesce(${orgOnboarding.firstMcpClient}, excluded.first_mcp_client)`,
        firstMcpTool: sql`coalesce(${orgOnboarding.firstMcpTool}, excluded.first_mcp_tool)`,
      },
      setWhere: or(
        isNull(orgOnboarding.firstMcpCallAt),
        and(
          isNull(orgOnboarding.firstMcpClient),
          sql`excluded.first_mcp_client is not null`,
        ),
        and(
          isNull(orgOnboarding.firstMcpTool),
          sql`excluded.first_mcp_tool is not null`,
        ),
      ),
    })
}
