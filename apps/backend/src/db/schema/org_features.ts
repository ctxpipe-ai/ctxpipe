import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"

import { organizations } from "./auth.js"
import { orgIsolationPolicy } from "./org-rls.js"

/**
 * One value for each feature of an org (ADR-069). An operator sets a value with SQL for now.
 */
export const orgFeatures = pgTable.withRLS(
  "org_features",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    feature: text("feature").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.feature] }),
    orgIsolationPolicy(t.organizationId),
  ],
)
