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
import { organizations } from "./auth.js"

export const dashboardMetricSnapshots = pgTable(
  "dashboard_metric_snapshots",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    metricDate: date("metric_date", { mode: "date" }).notNull(),
    contextConfidence: real("context_confidence"),
    activeClaims: integer("active_claims").notNull(),
    lowConfidenceClaims: integer("low_confidence_claims").notNull(),
    instructionUnits: integer("instruction_units"),
    evidenceLastObservedAt: timestamp("evidence_last_observed_at", {
      withTimezone: true,
      mode: "date",
    }),
    freshnessLt24h: integer("freshness_lt24h"),
    freshnessLt7d: integer("freshness_lt7d"),
    freshnessLt30d: integer("freshness_lt30d"),
    staleClaimsGt30d: integer("stale_claims_gt30d").notNull(),
    graphTotalNodes: integer("graph_total_nodes"),
    graphTotalEdges: integer("graph_total_edges"),
    graphEntityTypes: integer("graph_entity_types"),
    graphRelationshipTypes: integer("graph_relationship_types"),
    graphIsolatedNodes: integer("graph_isolated_nodes"),
    graphAverageDegree: real("graph_average_degree"),
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
