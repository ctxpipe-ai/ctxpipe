import { z } from "zod"

export const BillingEntitlementSchema = z.object({
  contractVersion: z.string(),
  orgId: z.string(),
  status: z.string(),
  plan: z.object({
    tier: z.string(),
    displayName: z.string(),
    billingPeriod: z.object({
      startsAt: z.string(),
      endsAt: z.string(),
    }),
  }),
  limits: z.object({
    repos: z.number().nullable(),
    connectors: z.number().nullable(),
    monthlyIncludedCalls: z.number().nullable(),
  }),
  usage: z.object({
    callsUsed: z.number(),
    callsRemaining: z.number().nullable(),
    shadowWeightedUnitsUsed: z.number(),
  }),
  enforcement: z.object({
    isHardBlocked: z.boolean(),
    blockingReason: z.string().nullable(),
    grace: z.object({
      isInGrace: z.boolean(),
      graceReason: z.string().nullable(),
      graceEndsAt: z.string().nullable(),
    }),
  }),
  degradation: z.object({
    isDegraded: z.boolean(),
    degradedReason: z.string().nullable(),
    sourceDataAsOf: z.string(),
  }),
})

export type BillingEntitlement = z.infer<typeof BillingEntitlementSchema>
