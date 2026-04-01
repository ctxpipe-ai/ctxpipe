/**
 * Per-ref git checkout: Zoekt repo id and resolved commit for the default (or named) checkout.
 * IDs: checkout_<base32 uuid>.
 */
import {
  index,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core"
import { repositories } from "./repositories.js"

export const repositoryCheckouts = pgTable(
  "repository_checkouts",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** Git ref (branch name or symbolic ref) used for this checkout. */
    ref: text("ref").notNull().default("main"),
    /** Resolved commit SHA at last index. */
    commitSha: text("commit_sha"),
    /** Path segment under repo cache (sanitized). */
    checkoutKey: text("checkout_key").notNull(),
    zoektRepoId: serial("zoekt_repo_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique().on(t.repositoryId, t.checkoutKey),
    index().on(t.repositoryId),
  ],
)
