import { and, asc, eq, isNull, lt, lte, sql } from "drizzle-orm"

import { deploymentEnvironment } from "../../../../shared/deployment-environment.js"
import { parseEnv } from "../config/env.js"
import { getSystemDb } from "../db/client.js"
import { members, organizations } from "../db/schema/auth.js"
import {
  type CrmIntakePayload,
  crmIntakeOutbox,
} from "../db/schema/crm_intake_outbox.js"
import { generateObjectId } from "../lib/id.js"
import { sqlState } from "../observability/dbTrace.js"
import { log } from "../observability/logger.js"

/*
 * Each sign-up becomes a person in the CRM of the ctxpipe team (CTX-1630).
 * The Better Auth hook writes a row to `crm_intake_outbox` and makes no
 * network call, so the CRM cannot slow down or fail a sign-up. The worker
 * sends the due rows to the CRM intake with a Cloudflare Access service token
 * and tries again with backoff until the intake accepts the row. Only hosted
 * production records and sends: a preview runs on a copy of the production
 * data, so a preview must never post, even when it has the variables.
 */

type Env = Record<string, string | undefined>

type CrmIntakeTarget = { url: string; clientId: string; clientSecret: string }

/** The minutes from the sign-up to the first send, so that the onboarding usually has made the organization. */
const FIRST_SEND_DELAY_MS = 5 * 60_000
/** A claimed row is not claimed again for this time, while its send runs. */
const CLAIM_LEASE_MS = 2 * 60_000
const STALE_AFTER_MS = 24 * 60 * 60_000

/** The intake refuses a larger body. */
const MAX_BODY_BYTES = 16 * 1024

/** The first 200 characters (code points) of a name, or undefined when it is empty. */
function shortName(value: string): string | undefined {
  return Array.from(value.trim()).slice(0, 200).join("") || undefined
}

/** The stable message of the alert on sign-ups that the CRM did not get in 24 hours. */
export const STALE_ALERT_MESSAGE =
  "CRM intake: sign-ups not sent for more than 24 hours"
/** The stable message of the alert on a sign-up that the intake refused. */
export const REFUSED_ALERT_MESSAGE = "CRM intake: the intake refused a sign-up"

/** True when this deployment records sign-ups: hosted production with `CRM_INTAKE_URL`. */
export function crmIntakeRecords(env: Env): boolean {
  return (
    deploymentEnvironment(env) === "production" &&
    parseEnv(env).CRM_INTAKE_URL !== undefined
  )
}

/** Where the worker sends, or undefined when this deployment must not send. */
function crmIntakeTarget(env: Env): CrmIntakeTarget | undefined {
  if (deploymentEnvironment(env) !== "production") return undefined
  const {
    CRM_INTAKE_URL: url,
    CRM_INTAKE_ACCESS_CLIENT_ID: clientId,
    CRM_INTAKE_ACCESS_CLIENT_SECRET: clientSecret,
  } = parseEnv(env)
  return url && clientId && clientSecret
    ? { url, clientId, clientSecret }
    : undefined
}

/**
 * Better Auth `databaseHooks.user.create.after`. Better Auth runs it after the
 * database work of the sign-up, in the same request. The Drizzle adapter here
 * has no transactions, so the row cannot be in the transaction of the user.
 * A failure does not fail the sign-up: the log names the SQLSTATE only, never
 * the user, and the sign-up does not get to the CRM.
 */
export async function recordSignupForCrm(user: {
  id: string
  email: string
  name: string
  createdAt: Date
}): Promise<void> {
  const name = shortName(user.name)
  try {
    await getSystemDb()
      .insert(crmIntakeOutbox)
      .values({
        id: generateObjectId("crmo"),
        userId: user.id,
        payload: {
          email: user.email,
          ...(name ? { name } : {}),
          occurredAt: new Date(user.createdAt).toISOString(),
          externalId: user.id,
        },
        nextAttemptAt: new Date(Date.now() + FIRST_SEND_DELAY_MS),
      })
      .onConflictDoNothing()
  } catch (error) {
    log.error({
      step: "crm-intake.record",
      message: "CRM intake: recording a sign-up failed",
      sqlState: sqlState(error),
    })
  }
}

/** The wait before the next try: 1 minute, doubled at each failed try, at most 1 hour. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000)
}

/** A row that no other worker sends now, with its `attempts` counted. */
async function claimDueRow(now: Date) {
  const t = crmIntakeOutbox
  const due = getSystemDb()
    .select({ id: t.id })
    .from(t)
    .where(and(isNull(t.sentAt), isNull(t.failedAt), lte(t.nextAttemptAt, now)))
    .orderBy(asc(t.nextAttemptAt))
    .limit(1)
    .for("update", { skipLocked: true })
  const [row] = await getSystemDb()
    .update(t)
    .set({
      attempts: sql`${t.attempts} + 1`,
      nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS),
    })
    // A scalar subquery runs once (see `workspace-sandboxes.ts`).
    .where(eq(t.id, sql`(${due})`))
    .returning({
      id: t.id,
      userId: t.userId,
      payload: t.payload,
      attempts: t.attempts,
    })
  return row
}

/** The name of the user's first organization, when the user has one. */
async function organizationName(userId: string): Promise<string | undefined> {
  const [org] = await getSystemDb()
    .select({ name: organizations.name })
    .from(members)
    .innerJoin(organizations, eq(members.organizationId, organizations.id))
    .where(eq(members.userId, userId))
    .orderBy(asc(members.createdAt))
    .limit(1)
  return org ? shortName(org.name) : undefined
}

/** The HTTP status, or a fixed code when no response came. The body is not read. */
async function post(
  target: CrmIntakeTarget,
  body: string,
): Promise<number | "timeout" | "network"> {
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Access-Client-Id": target.clientId,
        "CF-Access-Client-Secret": target.clientSecret,
      },
      body,
      // An Access refusal can be a redirect to a login page: do not follow it.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
    // Release the connection. Do not wait: the stream may never end.
    void response.body?.cancel().catch(() => {})
    return response.status
  } catch (error) {
    return error instanceof Error && error.name === "TimeoutError"
      ? "timeout"
      : "network"
  }
}

/**
 * Sends the due rows, one at a time, and records each result: 202 is sent;
 * 4xx other than 429 is a refusal, which stops the row and alerts; each other
 * result tries again later. Then it alerts when a row is older than 24 hours
 * and not sent. Each worker task can run it at the same time.
 */
export async function sendDueSignups(
  target: CrmIntakeTarget,
  now = new Date(),
): Promise<{ sent: number; retried: number; refused: number }> {
  const t = crmIntakeOutbox
  const counts = { sent: 0, retried: 0, refused: 0 }
  for (let i = 0; i < 50; i++) {
    const row = await claimDueRow(now)
    if (!row) break
    // The claim takes only unsent rows, and only a sent row has no payload.
    let payload = row.payload as CrmIntakePayload
    if (row.attempts === 1) {
      // The organization is added once, before the first try, so that each
      // try sends the same body and the intake stays idempotent.
      const company = await organizationName(row.userId)
      if (company) {
        payload = { ...payload, company }
        await getSystemDb().update(t).set({ payload }).where(eq(t.id, row.id))
      }
    }
    const body = JSON.stringify({ source: "app-signup", ...payload })
    const status =
      Buffer.byteLength(body) > MAX_BODY_BYTES
        ? "too_large"
        : await post(target, body)
    const lastStatus = String(status)
    if (status === 202) {
      counts.sent++
      await getSystemDb()
        .update(t)
        .set({ sentAt: now, lastStatus, payload: null })
        .where(eq(t.id, row.id))
    } else if (
      status === "too_large" ||
      (typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 429)
    ) {
      counts.refused++
      await getSystemDb()
        .update(t)
        .set({ failedAt: now, lastStatus })
        .where(eq(t.id, row.id))
      log.error({
        step: "crm-intake.refused",
        message: REFUSED_ALERT_MESSAGE,
        outboxId: row.id,
        status: lastStatus,
      })
    } else {
      counts.retried++
      await getSystemDb()
        .update(t)
        .set({
          lastStatus,
          nextAttemptAt: new Date(now.getTime() + retryDelayMs(row.attempts)),
        })
        .where(eq(t.id, row.id))
    }
  }
  const stale = await getSystemDb().$count(
    t,
    and(
      isNull(t.sentAt),
      isNull(t.failedAt),
      lt(t.createdAt, new Date(now.getTime() - STALE_AFTER_MS)),
    ),
  )
  if (stale > 0)
    log.error({ step: "crm-intake.stale", message: STALE_ALERT_MESSAGE, stale })
  if (counts.sent + counts.retried + counts.refused > 0)
    log.info({
      step: "crm-intake.send",
      message: "CRM intake: sent the due sign-ups",
      ...counts,
    })
  return counts
}

/**
 * Starts the send in the worker: at start and then each minute. It starts
 * nothing, and returns false, on each deployment that must not send.
 */
export function startCrmIntakeSender(env: Env = process.env): boolean {
  const target = crmIntakeTarget(env)
  if (!target) {
    if (crmIntakeRecords(env))
      log.error({
        step: "crm-intake.config",
        message:
          "CRM intake: CRM_INTAKE_URL is set, but the Access service token is not. The sign-ups wait in the outbox",
      })
    return false
  }
  let running = false
  const pass = () => {
    if (running) return
    running = true
    void sendDueSignups(target)
      .catch((error: unknown) =>
        log.error({
          step: "crm-intake.send",
          message: "CRM intake: the send failed",
          sqlState: sqlState(error),
        }),
      )
      .finally(() => {
        running = false
      })
  }
  pass()
  setInterval(pass, 60_000).unref()
  return true
}
