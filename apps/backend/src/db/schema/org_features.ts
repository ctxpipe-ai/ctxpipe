import {
  boolean,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core"

import { organizations } from "./auth.js"
import { orgIsolationPolicy } from "./org-rls.js"

/**
 * One value for each feature of an org (ADR-069, CTX-1394). The hosted config sets a value with `src/db/set-org-feature.ts` (CTX-1424). An operator sets a value with the `admin.set-org-feature` job (CTX-1646).
 */
export const orgFeatures = pgTable.withRLS(
  "org_features",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    feature: text("feature").notNull(),
    value: text("value").notNull(),
    /** An operator set the value. The config does not change it until the config names the same value. */
    held: boolean("held").notNull().default(false),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.feature] }),
    orgIsolationPolicy(t.organizationId),
  ],
)
