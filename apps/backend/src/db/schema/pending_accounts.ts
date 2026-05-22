import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { users } from "./auth.js"

/**
 * Staged OAuth account rows when linking hits “already linked to another user”.
 * Column shape mirrors `accounts` so confirm can `INSERT` into `accounts` with a new id.
 */
export const pendingAccounts = pgTable(
  "pending_accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    expiresAt: timestamp("expires_at").notNull(),
    /** Existing `accounts.id` to delete on successful claim. */
    conflictingAccountId: text("conflicting_account_id").notNull(),
  },
  (t) => [index("pending_accounts_userId_idx").on(t.userId)],
)
