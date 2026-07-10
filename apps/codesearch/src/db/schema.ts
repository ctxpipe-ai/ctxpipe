/**
 * Read-only mirror of backend tables. Migrations live in apps/backend.
 */
import {
  boolean,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core"

const repositoryIndexingStatusValues = [
  "queued",
  "running",
  "ready",
  "failed",
  "unindexing",
] as const
const repositoryIndexingStatusEnum = pgEnum(
  "repository_indexing_status",
  repositoryIndexingStatusValues,
)

export const repositories = pgTable("repositories", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  gitUrl: text("git_url").notNull(),
  indexReady: boolean("index_ready").notNull().default(false),
  indexingStatus: repositoryIndexingStatusEnum("indexing_status"),
  indexingError: text("indexing_error"),
  indexingFailedAt: timestamp("indexing_failed_at", {
    withTimezone: true,
    mode: "date",
  }),
  lastIngestedHash: text("last_ingested_hash"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
})

export const repositoryCheckouts = pgTable("repository_checkouts", {
  id: text("id").primaryKey(),
  repositoryId: text("repository_id").notNull(),
  ref: text("ref").notNull().default("main"),
  commitSha: text("commit_sha"),
  checkoutKey: text("checkout_key").notNull(),
  zoektRepoId: serial("zoekt_repo_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
})
