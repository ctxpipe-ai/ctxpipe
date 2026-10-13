import { sql } from "drizzle-orm"
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { apikeys, organizations } from "./auth.js"

/**
 * The organization set of one OAuth grant or one personal API key (ADR-051).
 * Each row sets exactly one owner:
 * - `grant_id`: the Better Auth `referenceId` of the consent and its tokens
 *   (`ogr_*`). A grant with no rows allows no organization.
 * - `api_key_id`: a personal API key. A key with no rows keeps its legacy
 *   scope: every current membership of the user.
 * Org API keys do not use this table; they stay bound to one organization.
 * The live membership check runs on each call.
 */
export const oauthGrantOrganizations = pgTable(
  "oauth_grant_organizations",
  {
    grantId: text("grant_id"),
    apiKeyId: text("api_key_id").references(() => apikeys.id, {
      onDelete: "cascade",
    }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "oauth_grant_organizations_one_owner",
      sql`num_nonnulls(${t.grantId}, ${t.apiKeyId}) = 1`,
    ),
    uniqueIndex("oauth_grant_organizations_grant_org_uidx").on(
      t.grantId,
      t.organizationId,
    ),
    uniqueIndex("oauth_grant_organizations_api_key_org_uidx").on(
      t.apiKeyId,
      t.organizationId,
    ),
    index("oauth_grant_organizations_organization_id_idx").on(t.organizationId),
  ],
)
