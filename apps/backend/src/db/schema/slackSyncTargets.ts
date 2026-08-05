import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { organizations } from "./auth.js"
import { connections } from "./connections.js"
import { repositories } from "./repositories.js"

export const slackSyncTargets = pgTable(
  "slack_sync_targets",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "restrict" }),
    branch: text("branch").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** `draft` | `awaiting_merge` | `initial_sync` | `live` */
    setupPhase: text("setup_phase").notNull().default("draft"),
    pendingConfigPullUrl: text("pending_config_pull_url"),
    pendingConfigPrCreating: boolean("pending_config_pr_creating")
      .notNull()
      .default(false),
    /** Retention window for backfill / live scope (days). */
    oldestDays: integer("oldest_days").notNull().default(90),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("slack_sync_targets_connection_id_uq").on(t.connectionId),
    index("slack_sync_targets_repository_id_idx").on(t.repositoryId),
  ],
)
