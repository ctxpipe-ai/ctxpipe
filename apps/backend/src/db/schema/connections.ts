import { sql } from "drizzle-orm"
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { organizations } from "./auth.js"

/** `connections.type` — provider connection rows. */
export const CONNECTION_TYPE_GITHUB = "github" as const
export const CONNECTION_TYPE_FORGE = "forge" as const
export const CONNECTION_TYPE_SLACK = "slack" as const
export const CONNECTION_TYPE_LINEAR = "linear" as const
export const CONNECTION_TYPE_NOTION = "notion" as const

export type ConnectionType =
  | typeof CONNECTION_TYPE_GITHUB
  | typeof CONNECTION_TYPE_FORGE
  | typeof CONNECTION_TYPE_SLACK
  | typeof CONNECTION_TYPE_LINEAR
  | typeof CONNECTION_TYPE_NOTION

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
    uniqueIndex("connections_slack_team_id_uq")
      .using("btree", sql`(${t.config}->>'teamId')`)
      .where(sql`${t.type} = 'slack'`),
  ],
)
