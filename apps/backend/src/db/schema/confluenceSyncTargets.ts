import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { organizations } from "./auth.js"
import { connections } from "./connections.js"
import { repositories } from "./repositories.js"

export const confluenceSyncTargets = pgTable(
  "confluence_sync_targets",
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
    /** `draft` — configuring; `awaiting_merge` — PR open for confluence/config.yaml; `initial_sync` — full sync running after merge; `live` — merged config drives sync */
    setupPhase: text("setup_phase").notNull().default("live"),
    pendingConfigPullUrl: text("pending_config_pull_url"),
    pendingConfigPrCreating: boolean("pending_config_pr_creating")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("confluence_sync_targets_connection_id_uq").on(t.connectionId),
    index("confluence_sync_targets_repository_id_idx").on(t.repositoryId),
  ],
)
