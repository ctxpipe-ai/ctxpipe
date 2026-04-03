import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { organizations } from "./auth.js"
import { forgeInstallations } from "./forgeInstallations.js"

export const confluenceSyncTargets = pgTable(
  "confluence_sync_targets",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    forgeInstallationId: text("forge_installation_id")
      .notNull()
      .references(() => forgeInstallations.id, { onDelete: "cascade" }),
    repositoryName: text("repository_name").notNull(),
    branch: text("branch").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("confluence_sync_targets_org_id_uq").on(t.orgId),
    index("confluence_sync_targets_forge_installation_id_idx").on(
      t.forgeInstallationId,
    ),
  ],
)
