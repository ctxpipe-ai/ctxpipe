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
import { orgIsolationPolicy } from "./org-rls.js"

/**
 * Context Workspace (`ws_`). One workspace repository URL per org; slug unique per org.
 */
export const workspaces = pgTable.withRLS(
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
    hydrateError: text("hydrate_error"),
    lastJobAt: timestamp("last_job_at", {
      withTimezone: true,
      mode: "date",
    }),
    hydratePhases: jsonb("hydrate_phases").$type<{
      url: string
      sha: string
      embeddings: boolean
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
    orgIsolationPolicy(t.orgId),
  ],
)

export const workspaceLinkedRepositories = pgTable.withRLS(
  "workspace_linked_repositories",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
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
    index("workspace_linked_repositories_org_id_idx").on(t.orgId),
    orgIsolationPolicy(t.orgId),
  ],
)

export const workspaceKnowledgeUnits = pgTable.withRLS(
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
    orgIsolationPolicy(t.orgId),
  ],
)

export const orgMemberPreferences = pgTable.withRLS(
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
  (t) => [
    primaryKey({ columns: [t.userId, t.orgId] }),
    orgIsolationPolicy(t.orgId),
  ],
)

/** Job id → commit SHA so a crash after push is idempotent on the remote. */
export const workspaceWriteJobs = pgTable.withRLS(
  "workspace_write_jobs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    desiredSha: text("desired_sha"),
    commitSha: text("commit_sha"),
    generation: integer("generation").notNull(),
    status: text("status").notNull().default("queued"),
    payload: jsonb("payload").$type<{
      linkAction?: "link" | "unlink"
      linkGitUrl?: string
      defaultBranch?: string
      jobWorkspaceUrl?: string
      conflictParentSha?: string | null
      remoteTipSha?: string | null
      mergeFiles?: Array<{ path: string; content: string }>
      mergeDeletePaths?: string[]
    } | null>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("workspace_write_jobs_workspace_id_idx").on(t.workspaceId),
    index("workspace_write_jobs_workspace_id_status_idx").on(
      t.workspaceId,
      t.status,
    ),
    index("workspace_write_jobs_org_id_idx").on(t.orgId),
    orgIsolationPolicy(t.orgId),
  ],
)

export const workspaceSandboxInstances = pgTable.withRLS(
  "workspace_sandbox_instances",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    orgId: text("org_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id"),
    desiredUrl: text("desired_url"),
    desiredGeneration: integer("desired_generation"),
    desiredSha: text("desired_sha"),
    provider: text("provider"),
    providerSandboxId: text("provider_sandbox_id"),
    latestSnapshotId: text("latest_snapshot_id"),
    latestRunId: text("latest_run_id"),
    state: text("state").notNull().default("live"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("workspace_sandbox_instances_workspace_id_idx").on(t.workspaceId),
    index("workspace_sandbox_instances_conversation_id_idx").on(
      t.conversationId,
    ),
    index("workspace_sandbox_instances_org_id_idx").on(t.orgId),
    uniqueIndex("workspace_sandbox_instances_live_job_workspace_uidx")
      .on(t.workspaceId)
      .where(
        sql`${t.kind} = 'job' and ${t.state} in ('live', 'destroy_failed')`,
      ),
    uniqueIndex("workspace_sandbox_instances_live_chat_conversation_uidx")
      .on(t.conversationId)
      .where(
        sql`${t.kind} = 'chat' and ${t.conversationId} is not null and ${t.state} in ('live', 'destroy_failed')`,
      ),
    orgIsolationPolicy(t.orgId),
  ],
)

/**
 * Durable first connector-target Workspace per org (source repo created_at, id).
 * Used by migration export assignment; not recomputed from random Workspace rows.
 */
export const orgFirstWorkspaces = pgTable.withRLS(
  "org_first_workspaces",
  {
    orgId: text("org_id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    sourceRepositoryId: text("source_repository_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [orgIsolationPolicy(t.orgId)],
)
