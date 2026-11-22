import {
  doublePrecision,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core"

import { organizations } from "./auth.js"
import { orgIsolationPolicy } from "./org-rls.js"

/** Native TanStack LockStore ownership; every operation is a short org transaction. */
export const sandboxLocks = pgTable.withRLS(
  "sandbox_locks",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    owner: text("owner").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    /**
     * The model cost in USD of the ingest step that holds the lock (CTX-1522).
     * The model proxy adds the gateway cost of each call of the lock owner.
     * The step reads it before it releases the lock. Null when the owner
     * made no model call. A new owner starts again at null.
     */
    modelCostUsd: doublePrecision("model_cost_usd"),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.key] }),
    orgIsolationPolicy(t.orgId),
  ],
)
