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

/**
 * Each purpose has its own key, `HMAC(AUTH_SECRET, "ctxpipe:capability:" +
 * purpose)`. The raw `AUTH_SECRET` also signs other tokens (codesearch
 * JWTs), so a token of another kind or purpose never has a good signature.
 */
function sign(
  encodedPayload: string,
  authSecret: string,
  purpose: string,
): string {
  const key = createHmac("sha256", authSecret)
    .update(`ctxpipe:capability:${purpose}`)
    .digest()
  return createHmac("sha256", key).update(encodedPayload).digest("base64url")
}

function encodeClaims<T extends { purpose: string }>(
  claims: T,
  authSecret: string,
): string {
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString(
    "base64url",
  )
  const token = `${encodedPayload}.${sign(encodedPayload, authSecret, claims.purpose)}`
  if (token.length > RUN_CAPABILITY_MAX_LENGTH)
    throw new Error("The capability is too long")
  return token
}

/**
 * The claims of a capability of `purpose`, when its signature is good with
 * that purpose's key and the payload matches `schema` (whose `purpose` is
 * the same literal).
 */
function decodeClaims<T>(
  token: string,
  authSecret: string,
  purpose: string,
  schema: z.ZodType<T>,
): T | undefined {
  if (token.length === 0 || token.length > RUN_CAPABILITY_MAX_LENGTH)
    return undefined
  const [encodedPayload, signature, extra] = token.split(".")
  if (!encodedPayload || !signature || extra) return undefined
  const expected = Buffer.from(sign(encodedPayload, authSecret, purpose))
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
        rootPath: workspaces.rootPath,
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
        ...(current.rootPath ? { rootPath: current.rootPath } : {}),
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
    input.purpose,
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

const ingestShardClaims = {
  version: z.literal(RUN_CAPABILITY_VERSION),
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  runId: z.string().min(1),
  shard: z.number().int().nonnegative(),
  /** The workflow step that holds the lock, for attribution only. */
  step: z.string().min(1),
  lockOwner: z.string().uuid(),
}

const IngestCapabilityClaimsSchema = z.object({
  ...ingestShardClaims,
  purpose: z.literal("workspace-ingest-model"),
})

/**
 * The claims of a step's tool-bridge capability (T04): the checkouts that
 * the bridge may read. The source checkout has its pinned commit; a
 * destination Workspace checkout has no commit, because codesearch serves
 * the published checkout of the repository. The capability length cap
 * limits the number of checkouts; the mint fails above it.
 */
export const WorkspaceIngestToolsClaimsSchema = z.object({
  ...ingestShardClaims,
  purpose: z.literal("workspace-ingest-tools"),
  checkouts: z
    .array(
      z.object({
        repositoryId: z.string().min(1),
        checkoutKey: z.string().min(1),
        sha: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .optional(),
      }),
    )
    .min(1),
})

export type WorkspaceIngestToolsClaims = z.infer<
  typeof WorkspaceIngestToolsClaimsSchema
>

type WorkspaceIngestRunCapabilityClaims = z.infer<
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

type IngestStepInput = {
  authSecret: string
  orgId: string
  orgSlug: string
  runId: string
  shard: number
  /** The workflow step, for attribution (not checked). */
  step: string
  /** The owner of the shard lock that the step holds. */
  lockOwner: string
}

/** Sign `claims` while their step holds the shard lock of an unfinished run. */
async function mintIngestCapability<
  T extends Parameters<typeof ingestShardIsHeld>[0] & { purpose: string },
>(authSecret: string, schema: z.ZodType<T>, claims: unknown): Promise<string> {
  const parsed = schema.parse(claims)
  if (!(await ingestShardIsHeld(parsed)))
    throw new Error("The ingest shard lock or run is not valid")
  return encodeClaims(parsed, authSecret)
}

async function verifyIngestCapability<
  T extends Parameters<typeof ingestShardIsHeld>[0],
>(
  authSecret: string,
  token: string,
  purpose: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  const claims = decodeClaims(token, authSecret, purpose, schema)
  if (!claims || !(await ingestShardIsHeld(claims))) return undefined
  return claims
}

function ingestStepClaims(input: IngestStepInput) {
  return {
    version: RUN_CAPABILITY_VERSION,
    orgId: input.orgId,
    orgSlug: input.orgSlug.trim(),
    runId: input.runId,
    shard: input.shard,
    step: input.step,
    lockOwner: input.lockOwner,
  }
}

/**
 * The model capability of one ingest step (ADR-052): bound to the org, the
 * ingestion run, the shard, and the owner of the shard lock. The model proxy
 * accepts it only while that owner holds the lock and the run is unfinished.
 * A chat capability is never an ingest capability, and the reverse.
 */
export function mintWorkspaceIngestRunCapability(
  input: IngestStepInput,
): Promise<string> {
  return mintIngestCapability(input.authSecret, IngestCapabilityClaimsSchema, {
    ...ingestStepClaims(input),
    purpose: "workspace-ingest-model",
  })
}

export function verifyWorkspaceIngestRunCapability(input: {
  authSecret: string
  token: string
}): Promise<WorkspaceIngestRunCapabilityClaims | undefined> {
  return verifyIngestCapability(
    input.authSecret,
    input.token,
    "workspace-ingest-model",
    IngestCapabilityClaimsSchema,
  )
}

/**
 * The tool-bridge capability of one ingest step (T04): bound as the model
 * capability, and to the checkouts the bridge may read. The same rule ends
 * it: the step's lock is gone, or the run has finished.
 */
export function mintWorkspaceIngestToolsCapability(
  input: IngestStepInput & {
    checkouts: WorkspaceIngestToolsClaims["checkouts"]
  },
): Promise<string> {
  return mintIngestCapability(
    input.authSecret,
    WorkspaceIngestToolsClaimsSchema,
    {
      ...ingestStepClaims(input),
      purpose: "workspace-ingest-tools",
      checkouts: input.checkouts,
    },
  )
}

export function verifyWorkspaceIngestToolsCapability(input: {
  authSecret: string
  token: string
}): Promise<WorkspaceIngestToolsClaims | undefined> {
  return verifyIngestCapability(
    input.authSecret,
    input.token,
    "workspace-ingest-tools",
    WorkspaceIngestToolsClaimsSchema,
  )
}
