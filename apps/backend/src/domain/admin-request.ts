import { z } from "zod"

/**
 * The request part of each operator job input (`openworkflow/workflows/admin.ts`):
 * the request id (also the idempotency key), who asked and who approved.
 */
export const adminRequest = z.object({
  requestId: z.uuid(),
  requestedBy: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("operator"), email: z.email() }),
    z.object({
      kind: z.literal("agent"),
      host: z.string().min(1),
      runUrl: z.url(),
    }),
  ]),
  approvedBy: z.email(),
})

export type AdminRequest = z.output<typeof adminRequest>
