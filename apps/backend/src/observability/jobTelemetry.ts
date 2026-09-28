import { context, trace } from "@opentelemetry/api"
import { z } from "zod"
import {
  type AttributionKey,
  contextWithAttributionBag,
  readAttribution,
  sanitizeAttribution,
} from "./attribution.js"

export const jobTelemetrySchema = z.object({
  "request.id": z.string().optional(),
  "enduser.id": z.string().optional(),
  "ctxpipe.org.id": z.string().optional(),
  "ctxpipe.org.slug": z.string().optional(),
})

export type JobTelemetry = z.infer<typeof jobTelemetrySchema>

export function captureJobTelemetry(): JobTelemetry | undefined {
  const bag = readAttribution()
  const telemetry: JobTelemetry = {}
  for (const key of [
    "request.id",
    "enduser.id",
    "ctxpipe.org.id",
    "ctxpipe.org.slug",
  ] as const) {
    const value = bag[key]
    if (value) telemetry[key] = value
  }
  if (
    !telemetry["request.id"] &&
    !telemetry["enduser.id"] &&
    !telemetry["ctxpipe.org.id"] &&
    !telemetry["ctxpipe.org.slug"]
  ) {
    return undefined
  }
  return telemetry
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

/** Fields from the job payload. Does not write them onto the caller's span. */
export function attributionPatchFromJobInput(
  input: unknown,
): Partial<Record<AttributionKey, string>> {
  if (!input || typeof input !== "object") return {}
  const record = input as Record<string, unknown>
  const patch: Partial<Record<AttributionKey, string>> = {}
  const orgId = stringField(record, "orgId")
  const orgSlug = stringField(record, "orgSlug")
  const connectionId =
    stringField(record, "connectionId") ??
    stringField(record, "githubConnectionId")
  const repositoryId = stringField(record, "repositoryId")
  if (orgId) patch["ctxpipe.org.id"] = orgId
  if (orgSlug) patch["ctxpipe.org.slug"] = orgSlug
  if (connectionId) patch["ctxpipe.connection.id"] = connectionId
  if (repositoryId) patch["ctxpipe.repository.id"] = repositoryId
  return patch
}

export function attachJobTelemetry<T>(
  input: T,
): T & { telemetry?: JobTelemetry } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input as T & { telemetry?: JobTelemetry }
  }
  const record = input as Record<string, unknown>
  if (record.telemetry && typeof record.telemetry === "object") {
    return input as T & { telemetry?: JobTelemetry }
  }
  const telemetry = captureJobTelemetry()
  if (!telemetry) return input as T & { telemetry?: JobTelemetry }
  return { ...record, telemetry } as T & { telemetry: JobTelemetry }
}

function telemetryFromInput(input: unknown): JobTelemetry {
  if (!input || typeof input !== "object") return {}
  const raw = (input as { telemetry?: unknown }).telemetry
  const parsed = jobTelemetrySchema.safeParse(raw)
  return parsed.success ? parsed.data : {}
}

/**
 * Put enqueue attribution on the active execution context.
 * OpenWorkflow already owns the trace: `workflow_run.execute` is its own
 * trace, linked to `workflow_run.create`, and step spans are its children.
 */
export async function restoreJobTelemetry<T>(
  input: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const fields = telemetryFromInput(input)
  const { context: withBag, bag } = contextWithAttributionBag(context.active())
  const bagPatch: Partial<Record<AttributionKey, string>> = {
    "ctxpipe.actor.type": "job",
  }
  if (fields["request.id"]) bagPatch["request.id"] = fields["request.id"]
  if (fields["enduser.id"]) bagPatch["enduser.id"] = fields["enduser.id"]
  const inputRecord =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : undefined
  const inputOrgId = inputRecord ? stringField(inputRecord, "orgId") : undefined
  const inputOrgSlug = inputRecord
    ? stringField(inputRecord, "orgSlug")
    : undefined
  if (
    !inputOrgSlug &&
    inputOrgId &&
    inputOrgId === fields["ctxpipe.org.id"] &&
    fields["ctxpipe.org.slug"]
  ) {
    bagPatch["ctxpipe.org.slug"] = fields["ctxpipe.org.slug"]
  }
  const attribution = sanitizeAttribution({
    ...bagPatch,
    ...attributionPatchFromJobInput(input),
  })
  for (const [key, value] of Object.entries(attribution)) {
    if (value) bag.set(key, value)
  }

  return context.with(withBag, async () => {
    trace.getActiveSpan()?.setAttributes(attribution)
    return fn()
  })
}
