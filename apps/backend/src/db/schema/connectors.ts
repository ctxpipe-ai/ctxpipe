import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core"

export const connectors = pgTable(
  "connectors",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    type: text("type").notNull(),
    config: jsonb("config").notNull().$type<{
      syncMode: "pr" | "auto"
      schedule: "hourly" | "daily" | "manual"
      githubToken?: string

      // Legacy basic-auth (deprecated — kept for backward compatibility)
      confluenceBaseUrl?: string
      confluenceEmail?: string
      confluenceApiToken?: string

      // OAuth 2.0 fields
      deploymentType?: "cloud" | "datacenter"
      // Cloud: resolved from accessible-resources after OAuth
      cloudId?: string
      // Encrypted refresh token (AES-256-GCM via crypto.ts)
      oauthRefreshToken?: string
      // Data Center only: customer-provided application link credentials
      oauthClientId?: string
      oauthClientSecret?: string
    }>(),
    enabled: boolean("enabled").notNull().default(true),
    githubRepoId: text("github_repo_id"),
    githubRepoName: text("github_repo_name"),
    githubBranch: text("github_branch"),
    lastPrNumber: integer("last_pr_number"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique().on(t.orgId, t.type),
    index().on(t.orgId),
    index().on(t.orgId, t.enabled),
  ],
)
