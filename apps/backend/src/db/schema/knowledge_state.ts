import { sql } from "drizzle-orm"
import {
  bigint,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core"

import { orgIsolationPolicy } from "./org-rls.js"
import { workspaces } from "./workspaces.js"

/**
 * The run state of the knowledge projection of one Workspace (ADR-067
 * decision 2), and the head of its tree (ADR-071 decision 4). Read and write
 * it only through `models/knowledge-state.ts`.
 */
export const knowledgeState = pgTable.withRLS(
  "knowledge_state",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    /** The last commit that a run applied in full; null before the first. */
    lastSha: text("last_sha"),
    /**
     * Not used since ADR-071: the tree versions own the recovery from a
     * stopped run. The column stays until the next major release (ADR-053).
     */
    attemptShas: text("attempt_shas")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * The branch of the tree of `last_sha`: the default branch of the
     * Workspace when that run started. Null before the first completed run.
     */
    branch: text("branch"),
    /**
     * The tree version that the last completed run wrote: a read shows the
     * tree rows of `branch` at or below it. Null before the first completed
     * run.
     */
    treeVersion: bigint("tree_version", { mode: "number" }),
    /** The projection version of the last completed run. */
    projectionVersion: text("projection_version"),
    runStatus: text("run_status")
      .$type<"running" | "completed" | "failed">()
      .notNull(),
    /** The count of `failed` documents after the last completed run. */
    failedCount: integer("failed_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [orgIsolationPolicy(t.organizationId)],
)

/**
 * The head of the tree of each projected branch of a Workspace (ADR-071
 * decision 4), the default branch included. The reader and the writer use
 * only this table. Read and write it only through `models/knowledge-state.ts`.
 */
export const knowledgeBranchHeads = pgTable.withRLS(
  "knowledge_branch_heads",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    branch: text("branch").notNull(),
    /** The last tip that a run of the branch applied in full; null before the first. */
    lastSha: text("last_sha"),
    /**
     * The merge base of the tip with the default branch, for an overlay;
     * null for a full tree.
     */
    mergeBase: text("merge_base"),
    /** The tree version that the last completed run wrote; 0 before the first. */
    treeVersion: bigint("tree_version", { mode: "number" }).notNull().default(0),
    /** The projection version of the last completed run. */
    projectionVersion: text("projection_version"),
    runStatus: text("run_status")
      .$type<"running" | "completed" | "failed">()
      .notNull(),
    /** The count of `failed` documents after the last completed run. */
    failedCount: integer("failed_count").notNull().default(0),
    /**
     * When a full tree of the branch last became the tree of the default
     * branch. A read of the default branch uses the head with the newest
     * time, until a run of a new default branch moves its head (the rename
     * sequence of ADR-071 decision 11). Null for an overlay.
     */
    defaultAt: timestamp("default_at", { withTimezone: true, mode: "date" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.branch] }),
    orgIsolationPolicy(t.organizationId),
  ],
)
