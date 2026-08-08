import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core"
import { connections } from "./connections.js"

export const LINEAR_DIRTY_ENTITY_TYPES = [
  "attachment",
  "comment",
  "customer",
  "customerNeed",
  "cycle",
  "document",
  "initiative",
  "initiativeUpdate",
  "issue",
  "issueLabel",
  "project",
  "projectUpdate",
  "user",
] as const

export type LinearDirtyEntityType = (typeof LINEAR_DIRTY_ENTITY_TYPES)[number]

export const linearDirtyEntities = pgTable(
  "linear_dirty_entities",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    entityType: text("entity_type").$type<LinearDirtyEntityType>().notNull(),
    externalId: text("external_id").notNull(),
    action: text("action").$type<"upsert" | "delete">().notNull(),
    firstDirtyAt: timestamp("first_dirty_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    lastEventAt: timestamp("last_event_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    revision: integer("revision").notNull().default(1),
  },
  (t) => [
    index("linear_dirty_entities_connection_id_idx").on(t.connectionId),
    index("linear_dirty_entities_flush_idx").on(
      t.connectionId,
      t.lastEventAt,
      t.firstDirtyAt,
    ),
    unique("linear_dirty_entities_connection_type_external_id_uq").on(
      t.connectionId,
      t.entityType,
      t.externalId,
    ),
  ],
)
