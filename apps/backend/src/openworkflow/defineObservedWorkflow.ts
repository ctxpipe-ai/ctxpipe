import {
  defineWorkflow as defineOpenWorkflow,
  type RetryPolicy,
  type Workflow,
  type WorkflowRunMetadata,
} from "openworkflow"
import type { z } from "zod"
import {
  type JobTelemetry,
  jobTelemetrySchema,
  restoreJobTelemetry,
} from "../observability/jobTelemetry.js"

export const CONNECTOR_TYPES = [
  "github",
  "linear",
  "notion",
  "slack",
  "confluence",
  "forge",
  "pagerduty",
] as const

export type ConnectorType = (typeof CONNECTOR_TYPES)[number]

type WorkflowSpecOf<Input, Output, RawInput> = Workflow<
  Input,
  Output,
  RawInput
>["spec"]

type DurationUnit =
  | "years"
  | "year"
  | "yrs"
  | "yr"
  | "y"
  | "months"
  | "month"
  | "mo"
  | "weeks"
  | "week"
  | "w"
  | "days"
  | "day"
  | "d"
  | "hours"
  | "hour"
  | "hrs"
  | "hr"
  | "h"
  | "minutes"
  | "minute"
  | "mins"
  | "min"
  | "m"
  | "seconds"
  | "second"
  | "secs"
  | "sec"
  | "s"
  | "milliseconds"
  | "millisecond"
  | "msecs"
  | "msec"
  | "ms"
type DurationUnitAnyCase =
  | Capitalize<DurationUnit>
  | Uppercase<DurationUnit>
  | Lowercase<DurationUnit>
/** Same shape as openworkflow's `DurationString`, which is not exported. */
type DurationString =
  | `${number}`
  | `${number}${DurationUnitAnyCase}`
  | `${number} ${DurationUnitAnyCase}`

type StepApi = {
  run: <Output>(
    config: {
      readonly name: string
      readonly retryPolicy?: Partial<RetryPolicy>
    },
    fn: () => Promise<Output | undefined> | Output | undefined,
  ) => Promise<Output>
  runWorkflow: <Input, Output, RawInput = Input>(
    spec: WorkflowSpecOf<Input, Output, RawInput>,
    input?: RawInput,
    options?: {
      readonly name?: string
      readonly timeout?: number | string | Date
    },
  ) => Promise<Output>
  sleep: (name: string, duration: DurationString) => Promise<void>
}

type ObservedCtx<Input> = {
  readonly input: Input
  readonly step: StepApi
  readonly version: string | null
  readonly run: WorkflowRunMetadata
}

type ObservedSpec<S extends z.ZodObject<z.ZodRawShape>> = {
  name: string
  version?: string
  schema: S
  retryPolicy?: Partial<RetryPolicy>
  connectorType?: ConnectorType
}

function withTelemetrySchema<S extends z.ZodObject<z.ZodRawShape>>(
  schema: S,
  workflowName: string,
) {
  if (typeof schema?.extend !== "function") {
    throw new Error(
      `Workflow ${workflowName} must use an object schema so job telemetry is kept on the input`,
    )
  }
  return schema.extend({
    telemetry: jobTelemetrySchema.optional(),
  })
}

export function defineWorkflow<
  S extends z.ZodObject<z.ZodRawShape>,
  Fn extends (ctx: ObservedCtx<z.output<S>>) => unknown,
>(
  spec: ObservedSpec<S>,
  fn: Fn,
): Workflow<z.output<S>, Awaited<ReturnType<Fn>>, z.input<S>> {
  const schema = withTelemetrySchema(spec.schema, spec.name)
  // Zod's standard-schema `validate` result is wider than `z.output` of a
  // generic object schema, so the extended schema is asserted once here.
  return defineOpenWorkflow(
    {
      name: spec.name,
      version: spec.version,
      retryPolicy: spec.retryPolicy,
      schema,
    } as Workflow<z.output<S>, Awaited<ReturnType<Fn>>, z.input<S>>["spec"],
    async (ctx) => {
      const input = ctx.input as z.output<S> & { telemetry?: JobTelemetry }
      return restoreJobTelemetry(
        input.telemetry,
        async () => fn({ ...ctx, input }),
        input,
        spec.name,
        spec.connectorType,
      )
    },
  ) as Workflow<z.output<S>, Awaited<ReturnType<Fn>>, z.input<S>>
}
