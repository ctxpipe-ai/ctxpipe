import { and, eq, isNull, or, sql } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import { users } from "../db/schema/auth.js"

/**
 * Keeps the first MCP call, client and tool a user's agent sends. Later
 * calls fill a missing client or tool and never overwrite one, and the
 * `where` skips the write once all three are known.
 */
export async function recordFirstMcpCall(input: {
  userId: string
  clientName?: string
  toolName?: string
}): Promise<void> {
  const client = input.clientName ?? null
  const tool = input.toolName ?? null
  await getSystemDb()
    .update(users)
    .set({
      firstMcpCallAt: sql`coalesce(${users.firstMcpCallAt}, now())`,
      firstMcpClient: sql`coalesce(${users.firstMcpClient}, ${client})`,
      firstMcpTool: sql`coalesce(${users.firstMcpTool}, ${tool})`,
    })
    .where(
      and(
        eq(users.id, input.userId),
        or(
          isNull(users.firstMcpCallAt),
          client === null ? undefined : isNull(users.firstMcpClient),
          tool === null ? undefined : isNull(users.firstMcpTool),
        ),
      ),
    )
}
