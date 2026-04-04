import { sql } from "drizzle-orm"
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { organizations, users } from "./auth.js"

export const forgeInstallations = pgTable(
  "forge_installations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    cloudId: text("cloud_id"),
    installationContext: text("installation_context"),
    installationId: text("installation_id"),
    appId: text("app_id"),
    appSystemToken: text("app_system_token"),
    /** From FIT `app.apiBaseUrl` (Forge lifecycle webhook); optional fallback uses cloudId. */
    atlassianApiBaseUrl: text("atlassian_api_base_url"),
    installedByUserId: text("installed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("pending"),
    lastEventPayload: jsonb("last_event_payload"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("forge_installations_org_id_uq").on(t.orgId),
    uniqueIndex("forge_installations_cloud_id_uq")
      .on(t.cloudId)
      .where(sql`${t.cloudId} is not null`),
    uniqueIndex("forge_installations_pending_installed_by_user_id_uq")
      .on(t.installedByUserId)
      .where(
        sql`${t.status} = 'pending' and ${t.installedByUserId} is not null`,
      ),
    index("forge_installations_cloud_id_idx").on(t.cloudId),
  ],
)
