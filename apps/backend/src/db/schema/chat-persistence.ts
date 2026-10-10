import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core"
import { conversations } from "./conversations.js"
import { orgIsolationPolicy } from "./org-rls.js"

export const chatThreads = pgTable.withRLS(
  "chat_threads",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    messagesJson: jsonb("messages_json").$type<unknown[]>().notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [orgIsolationPolicy(t.orgId)],
)

export const chatRuns = pgTable.withRLS(
  "chat_runs",
  {
    runId: text("run_id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    status: text("status").notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    finishedAt: bigint("finished_at", { mode: "number" }),
    error: text("error"),
    errorCode: text("error_code"),
    usageJson: jsonb("usage_json").$type<Record<string, unknown>>(),
    sandboxKey: text("sandbox_key"),
    detachedSince: bigint("detached_since", { mode: "number" }),
    cancelRequested: boolean("cancel_requested"),
    driverEpoch: integer("driver_epoch"),
  },
  (t) => [
    index("chat_runs_status_detached").on(t.status, t.detachedSince),
    index("chat_runs_thread_started").on(t.threadId, t.startedAt),
    orgIsolationPolicy(t.orgId),
  ],
)

export const chatInterrupts = pgTable.withRLS(
  "chat_interrupts",
  {
    interruptId: text("interrupt_id").primaryKey(),
    runId: text("run_id").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    status: text("status").notNull(),
    requestedAt: bigint("requested_at", { mode: "number" }).notNull(),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    payloadJson: jsonb("payload_json")
      .$type<Record<string, unknown>>()
      .notNull(),
    responseJson: jsonb("response_json").$type<unknown>(),
  },
  (t) => [orgIsolationPolicy(t.orgId)],
)

export const chatMetadata = pgTable.withRLS(
  "chat_metadata",
  {
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    orgId: text("org_id").notNull(),
    valueJson: jsonb("value_json").$type<unknown>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.namespace, t.key] }),
    orgIsolationPolicy(t.orgId),
  ],
)
