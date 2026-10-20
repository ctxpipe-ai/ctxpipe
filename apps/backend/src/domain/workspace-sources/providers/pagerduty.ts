import { z } from "zod"
import type { SourceScopeDefinition } from "./scope.js"

/**
 * The most services in one PagerDuty source. Each service adds incident
 * list requests to each sync, and PagerDuty limits the REST API requests of
 * one key in each minute. An on-call team selects far fewer services.
 */
export const PAGERDUTY_SOURCE_MAX_SERVICES = 100

/** A PagerDuty service id, for example `PSVC001`. */
export const pagerdutyServiceIdSchema = z
  .string()
  .regex(/^[A-Z0-9]{1,32}$/, "Use a PagerDuty service id, for example PSVC001")

export const pagerdutySourceScopeSchema = z
  .object({
    /** The services whose incidents sync (ADR-034). */
    services: z
      .array(pagerdutyServiceIdSchema)
      .min(1, "Select at least one PagerDuty service")
      .max(
        PAGERDUTY_SOURCE_MAX_SERVICES,
        `Select at most ${PAGERDUTY_SOURCE_MAX_SERVICES} PagerDuty services`,
      )
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "List each service one time",
      ),
  })
  .strict()

export type PagerdutySourceScope = z.infer<typeof pagerdutySourceScopeSchema>

/** The PagerDuty source scope: a set of service ids. */
export const pagerdutySourceScope: SourceScopeDefinition<PagerdutySourceScope> =
  {
    connectionType: "pagerduty",
    label: "PagerDuty",
    schema: pagerdutySourceScopeSchema,
    summarize: ({ services }) =>
      `${services.length} PagerDuty service${services.length === 1 ? "" : "s"}`,
  }
