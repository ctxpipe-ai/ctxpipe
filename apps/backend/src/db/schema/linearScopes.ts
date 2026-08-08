import { index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core"
import { connections } from "./connections.js"

export const LINEAR_SCOPE_RESOURCE_TYPES = [
  "team",
  "project",
  "document",
  "initiative",
] as const

export type LinearScopeResourceType =
  (typeof LINEAR_SCOPE_RESOURCE_TYPES)[number]

export const linearScopes = pgTable(
  "linear_scopes",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    type: text("type").$type<LinearScopeResourceType>().notNull(),
    title: text("title").notNull(),
    url: text("url"),
    parentExternalId: text("parent_external_id"),
    teamId: text("team_id"),
    teamKey: text("team_key"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("linear_scopes_connection_id_idx").on(t.connectionId),
    unique("linear_scopes_connection_type_external_id_uq").on(
      t.connectionId,
      t.type,
      t.externalId,
    ),
  ],
)
