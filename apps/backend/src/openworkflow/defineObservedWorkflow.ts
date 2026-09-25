import { defineWorkflow as defineOpenWorkflow } from "openworkflow"
import type { z } from "zod"
import {
  type JobTelemetry,
  jobTelemetrySchema,
  restoreJobTelemetry,
} from "../observability/jobTelemetry.js"

function withTelemetrySchema<T>(schema: T): T {
  if (
    !schema ||
    typeof schema !== "object" ||
    !("extend" in schema) ||
    typeof schema.extend !== "function"
  ) {
    return schema
  }
  return (schema as z.ZodObject<z.ZodRawShape>).extend({
    telemetry: jobTelemetrySchema.optional(),
  }) as T
}

export const defineWorkflow: typeof defineOpenWorkflow = (spec, fn) => {
  return defineOpenWorkflow(
    {
      ...spec,
      schema: withTelemetrySchema(spec.schema),
    },
    (async (ctx) => {
      const telemetry = (ctx.input as { telemetry?: JobTelemetry } | undefined)
        ?.telemetry
      return restoreJobTelemetry(telemetry, () => fn(ctx))
    }) as typeof fn,
  )
}
