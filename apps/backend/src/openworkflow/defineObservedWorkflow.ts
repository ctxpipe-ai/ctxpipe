import {
  defineWorkflow as defineOpenWorkflow,
  type Workflow,
} from "openworkflow"
import { z } from "zod"
import {
  attachJobTelemetryForSchema,
  type JobTelemetry,
  jobTelemetrySchema,
  restoreJobTelemetry,
} from "../observability/jobTelemetry.js"

type JobInput<S extends z.ZodType> = z.output<S> & { telemetry?: JobTelemetry }
type JobRaw<S extends z.ZodType> = z.input<S> & { telemetry?: JobTelemetry }

type OpenSpec = Workflow<unknown, unknown, unknown>["spec"]
type Step = Parameters<Workflow<unknown, unknown, unknown>["fn"]>[0]["step"]

type ObservedSpec<S extends z.ZodType> = Pick<
  OpenSpec,
  "name" | "version" | "retryPolicy"
> & {
  schema: S
}

function attachChildTelemetry(step: Step): void {
  const runWorkflow = step.runWorkflow
  step.runWorkflow = ((spec, input, options) =>
    runWorkflow.call(
      step,
      spec,
      attachJobTelemetryForSchema(spec.schema, input),
      options,
    )) as Step["runWorkflow"]
}

/** Accept enqueue telemetry beside any input schema without loosening it. */
function withTelemetry(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject)
    return schema.extend({ telemetry: jobTelemetrySchema.optional() })
  return z
    .looseObject({ telemetry: jobTelemetrySchema.optional() })
    .transform(({ telemetry, ...rest }, ctx) => {
      const parsed = schema.safeParse(rest)
      if (!parsed.success) {
        for (const issue of parsed.error.issues) ctx.addIssue({ ...issue })
        return z.NEVER
      }
      return telemetry ? { ...(parsed.data as object), telemetry } : parsed.data
    })
}

export function defineWorkflow<S extends z.ZodType, Output>(
  spec: ObservedSpec<S>,
  fn: (
    ctx: Parameters<Workflow<JobInput<S>, unknown, unknown>["fn"]>[0],
  ) => Promise<Output>,
): Workflow<JobInput<S>, Output, JobRaw<S>> {
  const schema = withTelemetry(spec.schema)
  return defineOpenWorkflow<JobInput<S>, Output, JobRaw<S>>(
    {
      name: spec.name,
      version: spec.version,
      retryPolicy: spec.retryPolicy,
      schema: schema as Workflow<
        JobInput<S>,
        Output,
        JobRaw<S>
      >["spec"]["schema"],
    },
    (ctx) => {
      attachChildTelemetry(ctx.step)
      // Telemetry is enqueue-only: bodies re-parse `input` with their own
      // strict schema, which has no `telemetry` key.
      const { telemetry: _telemetry, ...input } = ctx.input as JobInput<S>
      return restoreJobTelemetry(ctx.input, () =>
        fn({ ...ctx, input: input as JobInput<S> }),
      )
    },
  )
}
