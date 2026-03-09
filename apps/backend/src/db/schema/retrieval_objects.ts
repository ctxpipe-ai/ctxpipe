import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const retrievalObjects = pgTable(
  "retrieval_objects",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index().on(t.orgId),
    index().on(t.type),
    index().on(t.orgId, t.type),
  ],
)
