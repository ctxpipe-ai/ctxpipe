import { pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { organizations, users } from "./auth.js"
import { tenantRlsPolicies } from "./rls.js"

export const orgOnboarding = pgTable.withRLS(
  "org_onboarding",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    completedAt: timestamp("completed_at"),
    completedByUserId: text("completed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [...tenantRlsPolicies("org_onboarding", t.organizationId)],
)
