import { getOrgAdapter } from "better-auth/plugins"
import { and, eq } from "drizzle-orm"

import { disableOrgApiKeysMadeBy } from "../auth/ban.js"
import { getAuth } from "../auth/config.js"
import { type Db, getSystemDb } from "../db/client.js"
import { members, organizations, sessions } from "../db/schema/auth.js"
import { purgeOrgDataBeforeAuthDelete } from "./repositoryDeletion.js"

/*
 * Operator changes to an organization, run by the worker
 * (`openworkflow/workflows/admin.ts`). There is no acting member, so the
 * rules that protect the organization stay: it always keeps an owner.
 */

/** A rule of an operator job refused the change. A retry gives the same answer. */
export class AdminRefusal extends Error {}

/** The role list holds `owner`, the plugin's `creatorRole`. */
const hasOwnerRole = (role: string) =>
  role
    .split(",")
    .map((value) => value.trim())
    .includes("owner")

/**
 * In one transaction that locks the members of the organization: the member,
 * and the number of owners. Two jobs on one organization thus cannot both
 * take away its last owner.
 */
async function withLockedMember<T>(
  organizationId: string,
  memberId: string,
  change: (
    tx: Db,
    member: { userId: string; role: string; owners: number },
  ) => Promise<T>,
): Promise<T> {
  return getSystemDb().transaction(async (tx) => {
    const rows = await tx
      .select({ id: members.id, userId: members.userId, role: members.role })
      .from(members)
      .where(eq(members.organizationId, organizationId))
      .for("update")
    const member = rows.find((row) => row.id === memberId)
    if (!member)
      throw new AdminRefusal(
        `Member ${memberId} is not in organization ${organizationId}`,
      )
    const owners = rows.filter((row) => hasOwnerRole(row.role)).length
    return change(tx, { ...member, owners })
  })
}

export async function removeMember(input: {
  organizationId: string
  memberId: string
}): Promise<{ userId: string; disabledOrgApiKeys: number }> {
  return withLockedMember(
    input.organizationId,
    input.memberId,
    async (tx, member) => {
      if (hasOwnerRole(member.role) && member.owners <= 1)
        throw new AdminRefusal(
          `Member ${input.memberId} is the only owner of organization ${input.organizationId}`,
        )
      await tx.delete(members).where(eq(members.id, input.memberId))
      // The plugin does this for the session of the member that leaves.
      await tx
        .update(sessions)
        .set({ activeOrganizationId: null })
        .where(
          and(
            eq(sessions.userId, member.userId),
            eq(sessions.activeOrganizationId, input.organizationId),
          ),
        )
      // The member does not keep the organization's access through a key.
      const disabledOrgApiKeys = await disableOrgApiKeysMadeBy(
        tx,
        member.userId,
        input.organizationId,
      )
      return { userId: member.userId, disabledOrgApiKeys }
    },
  )
}

export async function setMemberRole(input: {
  organizationId: string
  memberId: string
  role: string
}): Promise<{ previousRole: string }> {
  return withLockedMember(
    input.organizationId,
    input.memberId,
    async (tx, member) => {
      if (
        hasOwnerRole(member.role) &&
        !hasOwnerRole(input.role) &&
        member.owners <= 1
      )
        throw new AdminRefusal(
          `Member ${input.memberId} is the only owner of organization ${input.organizationId}`,
        )
      await tx
        .update(members)
        .set({ role: input.role })
        .where(eq(members.id, input.memberId))
      return { previousRole: member.role }
    },
  )
}

export async function organizationExists(
  organizationId: string,
): Promise<boolean> {
  const [organization] = await getSystemDb()
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
  return Boolean(organization)
}

/**
 * The deletion of Better Auth's `/organization/delete`: its
 * `beforeDeleteOrganization` hook (in `auth/config.ts`, the purge of the
 * organization's data), then the plugin's own delete of the members, the
 * invitations and the organization, in its transaction. Each step can run
 * again after a crash.
 */
export async function deleteOrganization(
  organizationId: string,
): Promise<void> {
  await purgeOrgDataBeforeAuthDelete(organizationId)
  // The context type of our options is not assignable to the plain one.
  const context = (await getAuth().$context) as unknown as Parameters<
    typeof getOrgAdapter
  >[0]
  await getOrgAdapter(context).deleteOrganization(organizationId)
}
