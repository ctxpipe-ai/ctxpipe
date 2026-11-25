import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core"

import { apikeys, users } from "./auth.js"

/**
 * The user who made each organization API key. Better Auth keeps only the
 * organization of the key. A ban disables the keys that the user made, and
 * an operator's removal of a member disables that member's keys of the
 * organization (`src/auth/ban.ts`). A key made before this table has no row.
 */
export const orgApiKeyCreators = pgTable(
  "org_api_key_creators",
  {
    apiKeyId: text("api_key_id")
      .primaryKey()
      .references(() => apikeys.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("org_api_key_creators_user_id_idx").on(t.userId)],
)
