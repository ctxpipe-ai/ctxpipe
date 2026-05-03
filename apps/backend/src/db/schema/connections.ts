import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { organizations } from "./auth.js"

/** `connections.type` — GitHub App installation vs Atlassian Forge / Confluence. */
export const CONNECTION_TYPE_GITHUB = "github" as const
export const CONNECTION_TYPE_FORGE = "forge" as const

export type ConnectionType =
  | typeof CONNECTION_TYPE_GITHUB
  | typeof CONNECTION_TYPE_FORGE

export const connections = pgTable(
  "connections",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").$type<ConnectionType>().notNull(),
    config: jsonb("config").notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("connections_org_id_idx").on(t.orgId),
    index("connections_org_id_type_idx").on(t.orgId, t.type),
  ],
)
