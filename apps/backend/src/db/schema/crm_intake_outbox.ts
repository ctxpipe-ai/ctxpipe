import { sql } from "drizzle-orm"
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core"

import { users } from "./auth.js"

/** The body fields of a sign-up that the outbox keeps until the send. */
export type CrmIntakePayload = {
  email: string
  name?: string
  occurredAt: string
  externalId: string
}

/**
 * The sign-ups that the worker sends to the CRM intake (CTX-1630,
 * `src/domain/crm-intake.ts`). The Better Auth hook adds one row for each new
 * user. The worker sends the row and then clears `payload`, so the table keeps
 * no copy of the email or the name after the CRM accepted it. A deleted user
 * deletes its row. `last_status` holds an HTTP status or a fixed error code,
 * never a response body.
 */
export const crmIntakeOutbox = pgTable(
  "crm_intake_outbox",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    payload: jsonb("payload").$type<CrmIntakePayload>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    /** Set when the intake refused the row (a 4xx other than 429). */
    failedAt: timestamp("failed_at", { withTimezone: true, mode: "date" }),
    lastStatus: text("last_status"),
  },
  (t) => [
    index("crm_intake_outbox_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.sentAt} is null and ${t.failedAt} is null`),
  ],
)
