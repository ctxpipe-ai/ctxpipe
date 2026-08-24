import { sql } from "drizzle-orm"
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { organizations } from "./auth.js"
import { orgIsolationPolicy } from "./org-rls.js"

/** `connections.type` — provider connection rows. */
export const CONNECTION_TYPE_GITHUB = "github" as const
export const CONNECTION_TYPE_FORGE = "forge" as const
export const CONNECTION_TYPE_SLACK = "slack" as const
export const CONNECTION_TYPE_LINEAR = "linear" as const
export const CONNECTION_TYPE_NOTION = "notion" as const

export type ConnectionType =
  | typeof CONNECTION_TYPE_GITHUB
  | typeof CONNECTION_TYPE_FORGE
  | typeof CONNECTION_TYPE_SLACK
  | typeof CONNECTION_TYPE_LINEAR
  | typeof CONNECTION_TYPE_NOTION

export const connections = pgTable.withRLS(
  "connections",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").$type<ConnectionType>().notNull(),
    config: jsonb("config").notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("connections_org_id_idx").on(t.orgId),
    index("connections_org_id_type_idx").on(t.orgId, t.type),
    uniqueIndex("connections_slack_team_id_uq")
      .using("btree", sql`(${t.config}->>'teamId')`)
      .where(sql`${t.type} = 'slack'`),
    orgIsolationPolicy(t.orgId),
  ],
)

/**
 * UnRLS'd webhook bootstrap. Secrets stay on `connections.config`.
 * Installation/team ids are indexed and non-unique (one GitHub App can map
 * to multiple orgs). Lookup here, then `withOrgDbContext` for tenant rows.
 */
export const connectionDirectory = pgTable(
  "connection_directory",
  {
    connectionId: text("connection_id").primaryKey(),
    orgId: text("org_id").notNull(),
    type: text("type").$type<ConnectionType>().notNull(),
    githubInstallationId: text("github_installation_id"),
    slackTeamId: text("slack_team_id"),
    linearWorkspaceId: text("linear_workspace_id"),
    notionWorkspaceId: text("notion_workspace_id"),
    notionBotId: text("notion_bot_id"),
    forgeCloudId: text("forge_cloud_id"),
    forgeInstallationId: text("forge_installation_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("connection_directory_org_id_idx").on(t.orgId),
    index("connection_directory_github_installation_id_idx").on(
      t.githubInstallationId,
    ),
    index("connection_directory_slack_team_id_idx").on(t.slackTeamId),
    index("connection_directory_linear_workspace_id_idx").on(
      t.linearWorkspaceId,
    ),
    index("connection_directory_notion_workspace_id_idx").on(
      t.notionWorkspaceId,
    ),
    index("connection_directory_notion_bot_id_idx").on(t.notionBotId),
    index("connection_directory_forge_cloud_id_idx").on(t.forgeCloudId),
    index("connection_directory_forge_installation_id_idx").on(
      t.forgeInstallationId,
    ),
  ],
)
