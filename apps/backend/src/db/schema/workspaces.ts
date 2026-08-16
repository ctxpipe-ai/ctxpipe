import { sql } from "drizzle-orm"
import {
  index,
  integer,
  jsonb,
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
    lastJobAt: timestamp("last_job_at", {
      withTimezone: true,
      mode: "date",
    }),
    hydratePhases: jsonb("hydrate_phases").$type<{
      url: string
      sha: string
      embeddings: boolean
      graph: boolean
      remainders: boolean
    } | null>(),
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

export const workspaceKnowledgeUnits = pgTable(
  "workspace_knowledge_units",
  {
    servingId: text("serving_id").primaryKey(),
    orgId: text("org_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    body: text("body").notNull(),
    projectionSha: text("projection_sha").notNull(),
    links: jsonb("links").$type<string[]>().notNull().default([]),
    claims: jsonb("claims")
      .$type<
        Array<{
          to: string
          predicate: string | null
          confidence: number | null
          validFrom: string | null
          validTo: string | null
          source: string | null
        }>
      >()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    embedding: jsonb("embedding").$type<number[]>(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("workspace_knowledge_units_workspace_id_path_uidx").on(
      t.workspaceId,
      t.path,
    ),
    index("workspace_knowledge_units_workspace_id_idx").on(t.workspaceId),
    index("workspace_knowledge_units_org_id_idx").on(t.orgId),
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

export const orgWorkspaceCutover = pgTable("org_workspace_cutover", {
  orgId: text("org_id").primaryKey(),
  firstWorkspaceId: text("first_workspace_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
})

/** Job id → commit SHA so a crash after push is idempotent on the remote. */
export const workspaceWriteJobs = pgTable(
  "workspace_write_jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    desiredSha: text("desired_sha"),
    commitSha: text("commit_sha"),
    generation: integer("generation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("workspace_write_jobs_workspace_id_idx").on(t.workspaceId)],
)
