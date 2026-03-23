/**
 * Read-only mirror of backend tables. Migrations live in apps/backend.
 */
import { boolean, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core"

export const repositories = pgTable("repositories", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  gitUrl: text("git_url").notNull(),
  indexReady: boolean("index_ready").notNull().default(false),
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
  zoektIndexFingerprint: text("zoekt_index_fingerprint"),
  cgcIndexFingerprint: text("cgc_index_fingerprint"),
  indexFingerprint: text("index_fingerprint"),
  zoektIndexReady: boolean("zoekt_index_ready").notNull().default(false),
  cgcIndexReady: boolean("cgc_index_ready").notNull().default(false),
  cgcPartialJson: text("cgc_partial_json"),
  lastAccessedAt: timestamp("last_accessed_at", {
    withTimezone: true,
    mode: "date",
  }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
})
