import { z } from "zod"

import { banUser, revokeUserSessions, unbanUser } from "../../auth/ban.js"
import {
  AdminRefusal,
  deleteOrganization,
  organizationExists,
  removeMember,
  setMemberRole,
} from "../../domain/organization-admin.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/*
 * The operator jobs. The operator console enqueues them by name: it has
 * INSERT on `openworkflow.workflow_runs` only for `admin.*` runs
 * (`db/provision-console-role.ts`), with `requestId` as the idempotency key.
 * Each input names who asked and who approved. The output and the logs hold
 * ids only, never a name or an email of a user.
 */

const requestedBy = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operator"), email: z.email() }),
  z.object({
    kind: z.literal("agent"),
    host: z.string().min(1),
    runUrl: z.url(),
  }),
])

function adminInput<P extends z.ZodRawShape>(params: P) {
  return z.object({
    requestId: z.uuid(),
    requestedBy,
    approvedBy: z.email(),
    params: z.object(params),
  })
}

const id = z.string().min(1)

/**
 * `run` is a step. A step retries a failure, which suits a lost database
 * connection. An {@link AdminRefusal} (a rule of the job) does not retry:
 * the step ends, and the run fails with its message.
 */
function defineAdminWorkflow<P extends z.ZodRawShape, Output>(
  name: string,
  params: P,
  fn: (
    params: z.output<z.ZodObject<P>>,
    run: <T>(step: string, work: () => Promise<T>) => Promise<T>,
  ) => Promise<Output>,
) {
  const schema = adminInput(params)
  return defineWorkflow(
    {
      name,
      schema,
      // The ids of the params only: a ban reason is free text.
      logFields: (input) => ({
        requestId: input.requestId,
        ...Object.fromEntries(
          Object.entries(input.params ?? {}).filter(([key]) =>
            key.endsWith("Id"),
          ),
        ),
      }),
    },
    async ({ input, step }) => {
      // The worker does not check the input of a run that it did not
      // enqueue, and the console enqueues without this schema.
      const { params: parsed } = schema.parse(input)
      return fn(parsed, async (stepName, work) => {
        const outcome = await step.run({ name: stepName }, async () => {
          try {
            return { done: await work() }
          } catch (error) {
            if (error instanceof AdminRefusal) return { refused: error.message }
            throw error
          }
        })
        if ("refused" in outcome) throw new AdminRefusal(outcome.refused)
        return outcome.done
      })
    },
  )
}

export const adminBanUser = defineAdminWorkflow(
  "admin.ban-user",
  {
    userId: id,
    // Free text of the operator: kept on the user, never logged.
    reason: z.string().min(1),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    // Also the organization keys with no known maker (made before the maker
    // was recorded) of each organization of the user.
    disableUnattributedOrgApiKeys: z.boolean().optional(),
  },
  async ({ userId, reason, expiresAt, disableUnattributedOrgApiKeys }, run) => {
    const until = expiresAt ? new Date(expiresAt) : null
    const found = await run("ban", async () => {
      if (until && until.getTime() <= Date.now())
        throw new AdminRefusal("The ban must end in the future")
      return banUser({
        userId,
        reason,
        expiresAt: until,
        disableUnattributedOrgApiKeys,
      })
    })
    if (!found) throw new Error(`User ${userId} not found`)
    return { ok: true as const, userId, ...found }
  },
)

export const adminUnbanUser = defineAdminWorkflow(
  "admin.unban-user",
  { userId: id },
  async ({ userId }, run) => {
    if (!(await run("unban", () => unbanUser(userId))))
      throw new Error(`User ${userId} not found`)
    return { ok: true as const, userId }
  },
)

export const adminRevokeSessions = defineAdminWorkflow(
  "admin.revoke-sessions",
  { userId: id },
  async ({ userId }, run) => {
    const revokedSessions = await run("revoke", () =>
      revokeUserSessions(userId),
    )
    return { ok: true as const, userId, revokedSessions }
  },
)

export const adminRemoveMember = defineAdminWorkflow(
  "admin.remove-member",
  {
    organizationId: id,
    memberId: id,
    // Also the organization keys of the organization with no known maker.
    disableUnattributedOrgApiKeys: z.boolean().optional(),
  },
  async (params, run) => {
    const removed = await run("remove", () => removeMember(params))
    return {
      ok: true as const,
      organizationId: params.organizationId,
      memberId: params.memberId,
      ...removed,
    }
  },
)

export const adminSetMemberRole = defineAdminWorkflow(
  "admin.set-member-role",
  {
    organizationId: id,
    memberId: id,
    role: z.enum(["owner", "admin", "member"]),
  },
  async (params, run) => {
    const { previousRole } = await run("set-role", () => setMemberRole(params))
    return { ok: true as const, ...params, previousRole }
  },
)

export const adminDeleteOrganization = defineAdminWorkflow(
  "admin.delete-organization",
  { organizationId: id },
  async ({ organizationId }, run) => {
    // Its own step: a delete that runs again after a crash finds no row.
    if (!(await run("find", () => organizationExists(organizationId))))
      throw new AdminRefusal(`Organization ${organizationId} not found`)
    await run("delete", () => deleteOrganization(organizationId))
    return { ok: true as const, organizationId }
  },
)
