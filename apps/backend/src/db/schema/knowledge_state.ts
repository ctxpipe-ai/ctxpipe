import { sql } from "drizzle-orm"
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"

import { orgIsolationPolicy } from "./org-rls.js"
import { workspaces } from "./workspaces.js"

/**
 * The run state of the knowledge projection of one Workspace (ADR-067
 * decision 2). Read and write it only through `models/knowledge-state.ts`.
 */
export const knowledgeState = pgTable.withRLS(
  "knowledge_state",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    /** The last commit that a run applied in full; null before the first. */
    lastSha: text("last_sha"),
    /** The tips of the runs that started after `last_sha` and did not complete. */
    attemptShas: text("attempt_shas")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The projection version of the last completed run. */
    projectionVersion: text("projection_version"),
    runStatus: text("run_status")
      .$type<"running" | "completed" | "failed">()
      .notNull(),
    /** The count of `failed` documents after the last completed run. */
    failedCount: integer("failed_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [orgIsolationPolicy(t.organizationId)],
)
