import {
  date,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core"

export const dashboardMetricSnapshots = pgTable(
  "dashboard_metric_snapshots",
  {
    orgId: text("org_id").notNull(),
    metricDate: date("metric_date", { mode: "date" }).notNull(),
    contextConfidence: real("context_confidence"),
    activeClaims: integer("active_claims").notNull(),
    lowConfidenceClaims: integer("low_confidence_claims").notNull(),
    staleClaimsGt30d: integer("stale_claims_gt30d").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("dashboard_metric_snapshots_org_date_uniq").on(
      t.orgId,
      t.metricDate,
    ),
    index("dashboard_metric_snapshots_org_date_idx").on(t.orgId, t.metricDate),
  ],
)
