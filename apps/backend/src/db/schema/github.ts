import {
  boolean,
  pgTable,
  text,
  timestamp,
  unique,
  numeric
} from "drizzle-orm/pg-core"
import { organizations } from "./auth"

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    installationId: numeric("installation_id").notNull(),
    ingestAllRepositories: boolean("ingest_all_repositories")
      .notNull()
      .default(false),
    includeFutureRepos: boolean("include_future_repos")
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
  },
  (t) => [unique().on(t.orgId, t.installationId)],
)
