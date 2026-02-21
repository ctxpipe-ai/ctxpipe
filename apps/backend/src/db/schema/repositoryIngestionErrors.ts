import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const repositoryIngestionErrors = pgTable("repository_ingestion_errors", {
  id: text("id").primaryKey(),
  queueJobId: text("queue_job_id"),
  repositoryId: text("repository_id").notNull(),
  orgId: text("org_id").notNull(),
  targetHash: text("target_hash").notNull(),
  sourceBranch: text("source_branch"),
  fromHash: text("from_hash"),
  attemptCount: integer("attempt_count").notNull(),
  errorMessage: text("error_message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
})
