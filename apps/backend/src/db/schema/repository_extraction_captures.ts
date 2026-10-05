/**
 * Paid extractor output of one package root, stored by reference (ADR-047).
 * The ingestion workflow and the write job carry only the key; the publish
 * step reads these rows. A new run for the same key reuses them and makes no
 * model calls for the stored roots.
 */
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core"
import { orgIsolationPolicy } from "./org-rls.js"
import { repositories } from "./repositories.js"

export const repositoryExtractionCaptures = pgTable.withRLS(
  "repository_extraction_captures",
  {
    orgId: text("org_id").notNull(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** Extracted commit. */
    sourceSha: text("source_sha").notNull(),
    /** `full`, or `since:<sha>` for a partial ingest from that commit. */
    scope: text("scope").notNull(),
    extractorVersion: integer("extractor_version").notNull(),
    root: text("root").notNull(),
    /** Parts keep each JSON value small; one root can have many parts. */
    part: integer("part").notNull(),
    objects: jsonb("objects").$type<unknown[]>().notNull(),
    claims: jsonb("claims").$type<unknown[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.repositoryId,
        t.sourceSha,
        t.scope,
        t.extractorVersion,
        t.root,
        t.part,
      ],
    }),
    index("repository_extraction_captures_org_id_idx").on(t.orgId),
    orgIsolationPolicy(t.orgId),
  ],
)
