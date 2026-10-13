import { createHmac, timingSafeEqual } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { unfinishedOrgWorkflowRunIds } from "../../models/workspace-sandboxes.js"
import { INGESTION_V2_WORKFLOW_NAME } from "../ingestion/ingestion-run.js"
import { ingestSandboxThreadId } from "./chat-lifecycle.js"
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
  purpose: z.literal("workspace-chat-model"),
  orgId: z.string().min(1),
  orgSlug: z.string().min(1).optional(),
  conversationId: z.string().min(1),
  runId: z.string().min(1).optional(),
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

function encodeClaims(claims: object, authSecret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString(
    "base64url",
  )
  return `${encodedPayload}.${sign(encodedPayload, authSecret)}`
}

/**
 * The claims of a signed capability, when the signature is good and the
 * payload matches `schema`. Each purpose has its own schema with a literal
 * `purpose`, so a capability of one purpose never parses as another.
 */
function decodeClaims<T>(
  token: string,
  authSecret: string,
  schema: z.ZodType<T>,
): T | undefined {
  if (token.length === 0 || token.length > RUN_CAPABILITY_MAX_LENGTH)
    return undefined
  const [encodedPayload, signature, extra] = token.split(".")
  if (!encodedPayload || !signature || extra) return undefined
  const expected = Buffer.from(sign(encodedPayload, authSecret))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return undefined
  try {
    return schema.parse(
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
  orgSlug: string
  conversationId: string
  runId?: string
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
      orgSlug: input.orgSlug.trim(),
      conversationId: input.conversationId,
      ...(input.runId ? { runId: input.runId } : {}),
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
  const claims = decodeClaims(
    input.token,
    input.authSecret,
    RunCapabilityClaimsSchema,
  )
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

const IngestCapabilityClaimsSchema = z.object({
  version: z.literal(RUN_CAPABILITY_VERSION),
  purpose: z.literal("workspace-ingest-model"),
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  runId: z.string().min(1),
  shard: z.number().int().nonnegative(),
  /** The workflow step that holds the lock, for attribution only. */
  step: z.string().min(1),
  lockOwner: z.string().uuid(),
})

export type WorkspaceIngestRunCapabilityClaims = z.infer<
  typeof IngestCapabilityClaimsSchema
>

/**
 * True while `lockOwner` holds the shard lock of an unfinished ingestion run
 * of this org. A step takes the shard lock again for each step, so a
 * capability lasts one step at most.
 */
async function ingestShardIsHeld(input: {
  orgId: string
  runId: string
  shard: number
  lockOwner: string
}): Promise<boolean> {
  const [lock] = await withOrgDbContext(input.orgId, (db) =>
    db
      .select({ owner: sandboxLocks.owner })
      .from(sandboxLocks)
      .where(
        and(
          eq(sandboxLocks.orgId, input.orgId),
          eq(sandboxLocks.key, ingestSandboxThreadId(input.runId, input.shard)),
          eq(sandboxLocks.owner, input.lockOwner),
          sql`${sandboxLocks.expiresAt} > clock_timestamp()`,
        ),
      )
      .limit(1),
  )
  if (!lock) return false
  const unfinished = await unfinishedOrgWorkflowRunIds(
    input.orgId,
    INGESTION_V2_WORKFLOW_NAME,
    [input.runId],
  )
  return unfinished.has(input.runId)
}

/**
 * The model capability of one ingest step (ADR-052): bound to the org, the
 * ingestion run, the shard, and the owner of the shard lock. The model proxy
 * accepts it only while that owner holds the lock and the run is unfinished.
 * A chat capability is never an ingest capability, and the reverse.
 */
export async function mintWorkspaceIngestRunCapability(input: {
  authSecret: string
  orgId: string
  orgSlug: string
  runId: string
  shard: number
  /** The workflow step, for attribution (not checked). */
  step: string
  /** The owner of the shard lock that the step holds. */
  lockOwner: string
}): Promise<string> {
  const claims = IngestCapabilityClaimsSchema.parse({
    version: RUN_CAPABILITY_VERSION,
    purpose: "workspace-ingest-model",
    orgId: input.orgId,
    orgSlug: input.orgSlug.trim(),
    runId: input.runId,
    shard: input.shard,
    step: input.step,
    lockOwner: input.lockOwner,
  })
  if (!(await ingestShardIsHeld(claims)))
    throw new Error("The ingest shard lock or run is not valid")
  return encodeClaims(claims, input.authSecret)
}

export async function verifyWorkspaceIngestRunCapability(input: {
  authSecret: string
  token: string
}): Promise<WorkspaceIngestRunCapabilityClaims | undefined> {
  const claims = decodeClaims(
    input.token,
    input.authSecret,
    IngestCapabilityClaimsSchema,
  )
  if (!claims || !(await ingestShardIsHeld(claims))) return undefined
  return claims
}
