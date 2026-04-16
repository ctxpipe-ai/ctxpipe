import { date, index, pgTable, real, text, timestamp } from "drizzle-orm/pg-core"
import { tenantRlsPolicies } from "./rls.js"

export const claims = pgTable(
  "claims",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    subjectId: text("subject_id").notNull(),
    predicate: text("predicate").notNull(),
    objectId: text("object_id").notNull(),
    status: text("status").notNull(),
    validFrom: date("valid_from", { mode: "date" }),
    validTo: date("valid_to", { mode: "date" }),
    firstObservedAt: timestamp("first_observed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    lastObservedAt: timestamp("last_observed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    aggregatedConfidence: real("aggregated_confidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index().on(t.orgId),
    index().on(t.subjectId),
    index().on(t.objectId),
    index().on(t.status),
    ...tenantRlsPolicies("claims", t.orgId),
  ],
)
