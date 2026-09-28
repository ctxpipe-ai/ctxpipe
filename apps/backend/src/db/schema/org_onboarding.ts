import { pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { organizations, users } from "./auth.js"

export const orgOnboarding = pgTable("org_onboarding", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  completedAt: timestamp("completed_at"),
  completedByUserId: text("completed_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  /** First MCP request from an agent (OAuth or API key, never a web session). */
  firstMcpCallAt: timestamp("first_mcp_call_at"),
  /** `clientInfo.name` from the agent's `initialize`, e.g. `claude-code`. */
  firstMcpClient: text("first_mcp_client"),
  /** Name of the first `tools/call`, e.g. `ctx_advisor`. */
  firstMcpTool: text("first_mcp_tool"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
})
