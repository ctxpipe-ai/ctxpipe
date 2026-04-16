import {
  date,
  index,
  jsonb,
  pgTable as pgTableBase,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core"
import { organizations } from "./auth.js"
import { claims } from "./claims.js"
import { tenantRlsPolicies } from "./rls.js"

const pgTable = pgTableBase.withRLS

export const claimEvidence = pgTable(
  "claim_evidence",
  {
    id: text("id").primaryKey(),
    claimId: text("claim_id")
      .notNull()
      .references(() => claims.id),
    /**
     * Org ownership for tenant isolation (backfilled from claim).
     *
     * NOTE: initially nullable to allow safe backfill in migrations.
     */
    orgId: text("org_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
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
    index().on(t.orgId),
    index().on(t.logicalSourceKey),
    ...tenantRlsPolicies("claim_evidence", t.orgId),
  ],
)
