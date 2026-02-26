import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { repositories } from "./repositories.js"

export const repositoryIngestionQueue = pgTable(
  "repository_ingestion_queue",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    targetHash: text("target_hash").notNull(),
    sourceBranch: text("source_branch"),
    fromHash: text("from_hash"),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index().on(t.status, t.availableAt, t.createdAt),
    index().on(t.repositoryId, t.createdAt),
  ],
)
