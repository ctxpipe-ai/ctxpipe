import { pgTable, text, timestamp } from "drizzle-orm/pg-core"

/**
 * Transient OAuth state nonces stored between the start redirect and the
 * callback. Rows are deleted on successful callback or expire after 10 minutes.
 */
export const oauthStates = pgTable("oauth_states", {
  id: text("id").primaryKey(),                // random nonce used as `state` param
  connectorId: text("connector_id").notNull(),
  orgId: text("org_id").notNull(),
  orgSlug: text("org_slug").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
})
