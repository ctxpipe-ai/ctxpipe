import { pgTable, text, timestamp } from "drizzle-orm/pg-core"

/** App-level Notion connection webhook configuration. */
export const notionWebhookConfigs = pgTable("notion_webhook_configs", {
  id: text("id").primaryKey(),
  integrationId: text("integration_id"),
  verificationToken: text("verification_token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
})
