import { defineWorkflow as defineOpenWorkflow } from "openworkflow"
import {
  type JobTelemetry,
  jobTelemetrySchema,
  restoreJobTelemetry,
} from "../observability/jobTelemetry.js"

type ExtendableSchema<T> = {
  extend: (shape: {
    telemetry: ReturnType<typeof jobTelemetrySchema.optional>
  }) => T
}

function hasExtend<T>(schema: T): schema is T & ExtendableSchema<T> {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "extend" in schema &&
    typeof schema.extend === "function"
  )
}

function withTelemetrySchema<T>(schema: T): T {
  if (!hasExtend(schema)) return schema
  return schema.extend({
    telemetry: jobTelemetrySchema.optional(),
  })
}

type ObservedCtx = {
  input: { telemetry?: JobTelemetry }
  step: unknown
  version: string | null
  run: unknown
}

export const defineWorkflow: typeof defineOpenWorkflow = ((
  spec: {
    name: string
    version?: string
    schema?: unknown
    retryPolicy?: unknown
  },
  fn: (ctx: ObservedCtx) => unknown,
) => {
  return defineOpenWorkflow(
    {
      ...spec,
      schema: withTelemetrySchema(spec.schema),
    } as never,
    (async (ctx: ObservedCtx) => {
      return restoreJobTelemetry(
        ctx.input?.telemetry,
        async () => fn(ctx),
        ctx.input,
      )
    }) as never,
  )
}) as typeof defineOpenWorkflow
