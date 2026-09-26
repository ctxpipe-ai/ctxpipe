import {
  defineWorkflow as defineOpenWorkflow,
  type Workflow,
} from "openworkflow"
import type { z } from "zod"
import {
  attachJobTelemetry,
  type JobTelemetry,
  jobTelemetrySchema,
  restoreJobTelemetry,
} from "../observability/jobTelemetry.js"

type JobInput<S extends z.ZodType> = z.output<S> & { telemetry?: JobTelemetry }
type JobRaw<S extends z.ZodType> = z.input<S> & { telemetry?: JobTelemetry }

type OpenSpec = Workflow<unknown, unknown, unknown>["spec"]
type Step = Parameters<Workflow<unknown, unknown, unknown>["fn"]>[0]["step"]

type ObservedSpec<S extends z.ZodObject<z.ZodRawShape>> = Pick<
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
      attachJobTelemetry(input),
      options,
    )) as Step["runWorkflow"]
}

export function defineWorkflow<S extends z.ZodObject<z.ZodRawShape>, Output>(
  spec: ObservedSpec<S>,
  fn: (
    ctx: Parameters<Workflow<JobInput<S>, unknown, unknown>["fn"]>[0],
  ) => Promise<Output>,
): Workflow<JobInput<S>, Output, JobRaw<S>> {
  const schema = spec.schema.extend({
    telemetry: jobTelemetrySchema.optional(),
  })
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
      return restoreJobTelemetry(ctx.input, { name: spec.name }, () => fn(ctx))
    },
  )
}
