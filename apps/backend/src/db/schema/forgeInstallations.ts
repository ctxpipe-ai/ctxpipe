import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core"
import { organizations, users } from "./auth.js"

export const atlassianInstances = pgTable(
  "atlassian_instances",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    cloudId: text("cloud_id").notNull(),
    siteUrl: text("site_url").notNull(),
    siteName: text("site_name"),
    linkedByUserId: text("linked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.orgId), unique().on(t.cloudId)],
)

export const forgeInstallations = pgTable(
  "forge_installations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    cloudId: text("cloud_id").notNull(),
    installationContext: text("installation_context"),
    installationId: text("installation_id"),
    appId: text("app_id"),
    appSystemToken: text("app_system_token"),
    status: text("status").notNull().default("pending"),
    lastEventPayload: jsonb("last_event_payload"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.orgId), index().on(t.cloudId)],
)

export const confluenceSpacePageSelections = pgTable(
  "confluence_space_page_selections",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    cloudId: text("cloud_id").notNull(),
    spaceId: text("space_id").notNull(),
    spaceKey: text("space_key"),
    spaceName: text("space_name"),
    pageId: text("page_id").notNull(),
    pageTitle: text("page_title"),
    isSelected: boolean("is_selected").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.orgId, t.spaceId, t.pageId), index().on(t.orgId)],
)
