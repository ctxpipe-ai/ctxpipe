import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core"
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
