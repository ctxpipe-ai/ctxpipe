import {
  doublePrecision,
  integer,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core"

import { organizations } from "./auth.js"
import { orgIsolationPolicy } from "./org-rls.js"

/**
 * The model cost in USD of one ingestion v2 step (CTX-1522). The model proxy
 * adds the gateway cost of each call of the step. The step reads the sum
 * when it ends and puts it in its step output. Nothing clears the value, so
 * a step that runs again after a worker stop reads the cost of all its
 * calls, also of the calls before the stop.
 */
export const ingestModelCosts = pgTable.withRLS(
  "ingest_model_costs",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    shard: integer("shard").notNull(),
    step: text("step").notNull(),
    costUsd: doublePrecision("cost_usd").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.runId, t.shard, t.step] }),
    orgIsolationPolicy(t.orgId),
  ],
)
