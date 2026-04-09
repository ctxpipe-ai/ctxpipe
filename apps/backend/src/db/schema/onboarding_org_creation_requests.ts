import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { organizations, users } from "./auth.js"

export const onboardingOrgCreationRequests = pgTable(
  "onboarding_org_creation_requests",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("onboarding_org_creation_requests_user_key_uidx").on(
      table.userId,
      table.idempotencyKey,
    ),
    index("onboarding_org_creation_requests_organization_idx").on(
      table.organizationId,
    ),
  ],
)
