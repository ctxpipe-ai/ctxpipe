import {
  date,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core"
import { claims } from "./claims.js"
import { orgIsolationPolicy } from "./org-rls.js"

export const claimEvidence = pgTable.withRLS(
  "claim_evidence",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    claimId: text("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    /** Stable key for retraction / dedup (nullable for backcompat) */
    logicalSourceKey: text("logical_source_key"),
    sourceUrl: text("source_url"),
    extractionMethod: text("extraction_method").notNull(),
    confidence: real("confidence").notNull(),
    observedAt: timestamp("observed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    validFrom: date("valid_from", { mode: "date" }),
    validTo: date("valid_to", { mode: "date" }),
    provenance: jsonb("provenance"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index().on(t.claimId),
    index().on(t.logicalSourceKey),
    index("claim_evidence_org_id_idx").on(t.orgId),
    orgIsolationPolicy(t.orgId),
  ],
)
