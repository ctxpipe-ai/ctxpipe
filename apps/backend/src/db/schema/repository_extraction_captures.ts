/**
 * Retired (CTX-642): the extractor output of the old ingestion pipeline. No
 * code reads or writes this table any more. A minor release only adds
 * (ADR-053), so the table stays until the next major release drops it.
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
    objects: jsonb("objects").$type<unknown[]>().notNull(),
    claims: jsonb("claims").$type<unknown[]>().notNull(),
    /** Files the extractors skipped after a model error. Only a root with zero is reused. */
    skippedFiles: integer("skipped_files").notNull(),
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
      ],
    }),
    index("repository_extraction_captures_org_id_idx").on(t.orgId),
    orgIsolationPolicy(t.orgId),
  ],
)
