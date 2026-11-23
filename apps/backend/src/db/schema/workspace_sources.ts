import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core"

import { connections } from "./connections.js"
import { orgIsolationPolicy } from "./org-rls.js"
import { workspaces } from "./workspaces.js"

/**
 * The projection of `.ctxpipe/sources.yaml` at one Workspace revision
 * (ADR-050). Only the projection writes rows. A file-level error is one row
 * with the reserved key `.file`.
 */
export const workspaceSources = pgTable.withRLS(
  "workspace_sources",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /**
     * The path of the source file, relative to the Workspace root folder
     * (`sources/github/acme/web.md`, ADR-050 revision 2026-10-16). Until the
     * conversion is done, a `.ctxpipe/sources.yaml` entry uses its id.
     */
    sourceKey: text("source_key").notNull(),
    /** Null when the entry has no valid connection id (status `invalid`). */
    connectionId: text("connection_id"),
    /** Null when the entry has no known provider (status `invalid`). */
    provider: text("provider"),
    scope: jsonb("scope")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text("status")
      .$type<"ok" | "invalid" | "connection_missing" | "out_of_access">()
      .notNull(),
    statusDetail: text("status_detail"),
    /**
     * The pinned state of the source, for example the SHAs of the linked
     * GitHub repositories (ADR-046, ADR-050). Read and write it only through
     * `models/workspace-source-state.ts`, which types it per provider.
     */
    state: jsonb("state").$type<unknown>().notNull().default({}),
    revision: text("revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("workspace_sources_workspace_id_source_key_uidx").on(
      t.workspaceId,
      t.sourceKey,
    ),
    index("workspace_sources_connection_id_idx").on(t.connectionId),
    index("workspace_sources_org_id_idx").on(t.orgId),
    orgIsolationPolicy(t.orgId),
  ],
)

/**
 * Provider webhook events that wait for one coalesced sources sync of their
 * connection (CTX-1595). A webhook adds a row. The sync run that takes the
 * rows writes its run id in `run_id`, syncs all of them in one pass, and then
 * deletes them. A row of a run that ended without the delete goes to the
 * next run of the connection.
 */
export const sourceSyncEvents = pgTable.withRLS(
  "source_sync_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    /** The provider event, as the source adapter reads it. */
    event: jsonb("event").$type<unknown>().notNull(),
    /** The OpenWorkflow run that took the event; null while it waits. */
    runId: text("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("source_sync_events_connection_id_idx").on(
      t.connectionId,
      t.createdAt,
    ),
    orgIsolationPolicy(t.orgId),
  ],
)
