import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"
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
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.key] }),
    orgIsolationPolicy(t.orgId),
  ],
)
