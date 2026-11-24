import {
  index,
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
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.key] }),
    orgIsolationPolicy(t.orgId),
  ],
)

/**
 * The semantic merges that wait for the merge lease of their Workspace, in
 * order (CTX-1598). A merge run adds its row when it finds the lease busy and
 * deletes it when it takes the lease. A row of a run that ended is ignored
 * and deleted at the next take.
 */
export const workspaceMergeWaiters = pgTable.withRLS(
  "workspace_merge_waiters",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    runId: text("run_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.runId] }),
    index("workspace_merge_waiters_workspace_idx").on(
      t.workspaceId,
      t.createdAt,
    ),
    orgIsolationPolicy(t.orgId),
  ],
)
