import { createHmac, timingSafeEqual } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  sameWorkspaceBinding,
  type WorkspaceRevision,
  workspaceRevisionSchema,
} from "./revision.js"

const RUN_CAPABILITY_MAX_LENGTH = 8_192
const RUN_CAPABILITY_VERSION = 1
const RUN_CAPABILITY_KEY_PREFIX = "chat-thread:"

const RunCapabilityClaimsSchema = z.object({
  version: z.literal(RUN_CAPABILITY_VERSION),
  purpose: z.enum(["workspace-chat-git", "workspace-chat-model"]),
  orgId: z.string().min(1),
  conversationId: z.string().min(1),
  lockOwner: z.string().uuid(),
  revision: workspaceRevisionSchema,
})

export type WorkspaceChatRunCapabilityClaims = z.infer<
  typeof RunCapabilityClaimsSchema
>
export type WorkspaceChatRunCapabilityPurpose =
  WorkspaceChatRunCapabilityClaims["purpose"]

function sign(encodedPayload: string, authSecret: string): string {
  return createHmac("sha256", authSecret)
    .update(encodedPayload)
    .digest("base64url")
}

function encodeClaims(
  claims: WorkspaceChatRunCapabilityClaims,
  authSecret: string,
): string {
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString(
    "base64url",
  )
  return `${encodedPayload}.${sign(encodedPayload, authSecret)}`
}

function decodeClaims(
  token: string,
  authSecret: string,
): WorkspaceChatRunCapabilityClaims | undefined {
  if (token.length === 0 || token.length > RUN_CAPABILITY_MAX_LENGTH)
    return undefined
  const [encodedPayload, signature, extra] = token.split(".")
  if (!encodedPayload || !signature || extra) return undefined
  const expected = Buffer.from(sign(encodedPayload, authSecret))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return undefined
  try {
    return RunCapabilityClaimsSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
    )
  } catch {
    return undefined
  }
}

async function currentRunState(
  orgId: string,
  conversationId: string,
  lockOwner?: string,
): Promise<{ owner: string; revision: WorkspaceRevision } | undefined> {
  return withOrgDbContext(orgId, async (db) => {
    const [current] = await db
      .select({
        owner: sandboxLocks.owner,
        workspaceId: workspaces.id,
        generation: workspaces.desiredGeneration,
        url: workspaces.workspaceRepositoryUrl,
        connectionId: workspaces.githubConnectionId,
        sha: workspaces.desiredSha,
        defaultBranch: workspaces.desiredDefaultBranch,
      })
      .from(sandboxLocks)
      .innerJoin(
        conversations,
        and(
          eq(conversations.id, conversationId),
          eq(conversations.orgId, orgId),
        ),
      )
      .innerJoin(
        workspaces,
        and(
          eq(workspaces.id, conversations.workspaceId),
          eq(workspaces.orgId, orgId),
        ),
      )
      .where(
        and(
          eq(sandboxLocks.orgId, orgId),
          eq(sandboxLocks.key, `${RUN_CAPABILITY_KEY_PREFIX}${conversationId}`),
          ...(lockOwner ? [eq(sandboxLocks.owner, lockOwner)] : []),
          sql`${sandboxLocks.expiresAt} > clock_timestamp()`,
        ),
      )
      .limit(1)
    if (!current?.sha || !current.defaultBranch) return undefined
    return {
      owner: current.owner,
      revision: workspaceRevisionSchema.parse({
        workspaceId: current.workspaceId,
        generation: current.generation,
        remote: { url: current.url, connectionId: current.connectionId },
        sha: current.sha,
        defaultBranch: current.defaultBranch,
        access: "read",
      }),
    }
  })
}

export async function mintWorkspaceChatRunCapability(input: {
  authSecret: string
  orgId: string
  conversationId: string
  expectedOwner: string
  revision: WorkspaceRevision
  purpose: WorkspaceChatRunCapabilityPurpose
}): Promise<string> {
  const state = await currentRunState(
    input.orgId,
    input.conversationId,
    input.expectedOwner,
  )
  if (!state)
    throw new Error("Workspace chat transcript lock or binding is not valid")
  if (!sameWorkspaceBinding(state.revision, input.revision))
    throw new Error("Workspace chat capability revision binding changed")
  return encodeClaims(
    {
      version: RUN_CAPABILITY_VERSION,
      purpose: input.purpose,
      orgId: input.orgId,
      conversationId: input.conversationId,
      lockOwner: state.owner,
      revision: input.revision,
    },
    input.authSecret,
  )
}

export async function verifyWorkspaceChatRunCapability(input: {
  authSecret: string
  token: string
  purpose: WorkspaceChatRunCapabilityPurpose
}): Promise<WorkspaceChatRunCapabilityClaims | undefined> {
  const claims = decodeClaims(input.token, input.authSecret)
  if (!claims || claims.purpose !== input.purpose) return undefined
  const current = await currentRunState(
    claims.orgId,
    claims.conversationId,
    claims.lockOwner,
  )
  if (!current || !sameWorkspaceBinding(current.revision, claims.revision))
    return undefined
  return claims
}
