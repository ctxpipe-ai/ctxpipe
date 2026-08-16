import { sql } from "drizzle-orm"
import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { connections } from "./connections.js"

/**
 * Context Workspace (`ws_`). One workspace repository URL per org; slug unique per org.
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    workspaceRepositoryUrl: text("workspace_repository_url").notNull(),
    githubConnectionId: text("github_connection_id").references(
      () => connections.id,
      { onDelete: "set null" },
    ),
    desiredGeneration: integer("desired_generation").notNull().default(1),
    desiredSha: text("desired_sha"),
    activeProjectionUrl: text("active_projection_url"),
    activeProjectionSha: text("active_projection_sha"),
    indexedSha: text("indexed_sha"),
    writeStatus: text("write_status").notNull().default("unknown"),
    hydrateStatus: text("hydrate_status").notNull().default("pending"),
    readOnlyReason: text("read_only_reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("workspaces_org_id_slug_uidx").on(
      t.orgId,
      sql`lower(${t.slug})`,
    ),
    unique("workspaces_org_id_repository_url_uidx").on(
      t.orgId,
      t.workspaceRepositoryUrl,
    ),
    index("workspaces_org_id_idx").on(t.orgId),
  ],
)

export const workspaceLinkedRepositories = pgTable(
  "workspace_linked_repositories",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    gitUrl: text("git_url").notNull(),
    desiredRef: text("desired_ref"),
    desiredSha: text("desired_sha"),
    indexedSha: text("indexed_sha"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("workspace_linked_repositories_workspace_id_git_url_uidx").on(
      t.workspaceId,
      t.gitUrl,
    ),
    index("workspace_linked_repositories_workspace_id_idx").on(t.workspaceId),
  ],
)

export const orgMemberPreferences = pgTable(
  "org_member_preferences",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    lastUsedWorkspaceId: text("last_used_workspace_id").references(
      () => workspaces.id,
      { onDelete: "set null" },
    ),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.orgId] })],
)
