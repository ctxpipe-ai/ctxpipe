import { sql } from "drizzle-orm"
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { organizations, users } from "./auth.js"

export const agentActivityEvents = pgTable(
  "agent_activity_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    eventType: text("event_type").notNull(),
    subjectId: text("subject_id"),
    metadata: jsonb("metadata")
      .notNull()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("agent_activity_events_org_occurred_idx").on(t.orgId, t.occurredAt),
    index("agent_activity_events_org_user_occurred_idx").on(
      t.orgId,
      t.userId,
      t.occurredAt,
    ),
    index("agent_activity_events_org_source_occurred_idx").on(
      t.orgId,
      t.source,
      t.occurredAt,
    ),
  ],
)
