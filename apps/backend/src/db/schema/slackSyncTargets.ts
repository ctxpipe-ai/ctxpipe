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

export const SLACK_SETUP_PHASES = ["draft", "live"] as const
export type SlackSetupPhase = (typeof SLACK_SETUP_PHASES)[number]

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
    setupPhase: text("setup_phase")
      .$type<SlackSetupPhase>()
      .notNull()
      .default("draft"),
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
