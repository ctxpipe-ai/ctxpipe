import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { organizations } from "./auth"

export const githubInstallations = pgTable("github_installations", {
  id: text("id").primaryKey(),
  installationId: text("installation_id").notNull(),
  // including repos added in the future
  ingestAllRepositories: boolean("ingest_all_repositories")
    .notNull()
    .default(false),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
})
