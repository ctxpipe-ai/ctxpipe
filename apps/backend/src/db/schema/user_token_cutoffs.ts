import { pgTable, text, timestamp } from "drizzle-orm/pg-core"

import { users } from "./auth.js"

/**
 * A JWT access token of the user issued before `revoked_before` is not
 * accepted. No row can revoke a JWT, so a ban writes this time: after an
 * unban, a token from before the ban stays refused (`src/auth/ban.ts`).
 */
export const userTokenCutoffs = pgTable("user_token_cutoffs", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  revokedBefore: timestamp("revoked_before", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
})
