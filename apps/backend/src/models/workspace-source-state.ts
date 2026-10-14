import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import type { Db } from "../db/client.js"
import { workspaceSources } from "../db/schema/workspace_sources.js"
import { generateObjectId } from "../lib/id.js"
import { log } from "../observability/logger.js"

/**
 * The only reader and writer of `workspace_sources.state` (ADR-046,
 * ADR-050). The state is typed per provider. A row whose state does not
 * parse has an empty state: the read logs it and never throws.
 */

const githubRepositoryPinSchema = z.object({
  /** The stable link id (`wlr_…`) of `LinkedRevision` and the HTTP API. */
  id: z.string().regex(/^wlr_/),
  gitUrl: z.string().min(1),
  /** The branch or tag of the file; null is the default branch. */
  ref: z.string().min(1).nullable(),
  desiredSha: z.string().min(1).nullable(),
  indexedSha: z.string().min(1).nullable(),
  createdAt: z.iso.datetime(),
})

export type GithubRepositoryPin = z.infer<typeof githubRepositoryPinSchema>

/** Each provider adds its member. The key is the provider of the row. */
export const sourceStateSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("github"),
    repositories: z.array(githubRepositoryPinSchema),
  }),
])

export type SourceState = z.infer<typeof sourceStateSchema>
export type GithubSourceState = Extract<SourceState, { provider: "github" }>

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Queryable = Db | Tx

/** Parse the state of one row. An empty or invalid state gives null. */
export function parseSourceState(row: {
  id: string
  provider: string | null
  state: unknown
}): SourceState | null {
  const state = row.state
  if (
    state == null ||
    (typeof state === "object" &&
      !Array.isArray(state) &&
      Object.keys(state).length === 0)
  )
    return null
  const parsed = sourceStateSchema.safeParse(state)
  if (parsed.success && parsed.data.provider === row.provider)
    return parsed.data
  log.warn({
    step: "workspace_sources.state_invalid",
    sourceId: row.id,
    provider: row.provider,
    message: parsed.success
      ? `The state is for provider ${parsed.data.provider}`
      : parsed.error.message,
  })
  return null
}

/** The GitHub pins of one row, or none. */
export function githubPins(row: {
  id: string
  provider: string | null
  state: unknown
}): GithubRepositoryPin[] {
  const state = parseSourceState(row)
  return state?.provider === "github" ? state.repositories : []
}

/**
 * The next GitHub state for the repositories that the file wants. A
 * repository with the same URL and ref keeps its id and SHAs. A new
 * repository, or one with a changed ref, gets a new id and no SHAs.
 */
export function reconcileGithubState(
  previous: readonly GithubRepositoryPin[],
  wanted: ReadonlyArray<{ gitUrl: string; ref: string | null }>,
  now: Date = new Date(),
): GithubSourceState {
  const byUrl = new Map(previous.map((pin) => [pin.gitUrl, pin]))
  return {
    provider: "github",
    repositories: wanted.map(({ gitUrl, ref }) => {
      const current = byUrl.get(gitUrl)
      if (current && current.ref === ref) return current
      return {
        id: generateObjectId("wlr"),
        gitUrl,
        ref,
        desiredSha: null,
        indexedSha: null,
        createdAt: now.toISOString(),
      }
    }),
  }
}

/** One linked repository of a Workspace, from the state of a GitHub source row. */
export type LinkedRepositoryPin = {
  id: string
  orgId: string
  workspaceId: string
  /** The `workspace_sources` row that holds the pin. */
  sourceId: string
  gitUrl: string
  desiredRef: string | null
  desiredSha: string | null
  indexedSha: string | null
  createdAt: Date
}

function toLinked(
  row: { id: string; orgId: string; workspaceId: string },
  pin: GithubRepositoryPin,
): LinkedRepositoryPin {
  return {
    id: pin.id,
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    sourceId: row.id,
    gitUrl: pin.gitUrl,
    desiredRef: pin.ref,
    desiredSha: pin.desiredSha,
    indexedSha: pin.indexedSha,
    createdAt: new Date(pin.createdAt),
  }
}

/**
 * The linked repositories of the org in the current database context, in
 * creation order. `workspaceId` limits the read to one Workspace.
 */
export async function listLinkedRepositoryPins(
  db: Queryable,
  filter: { orgId?: string; workspaceId?: string } = {},
): Promise<LinkedRepositoryPin[]> {
  const rows = await db
    .select({
      id: workspaceSources.id,
      orgId: workspaceSources.orgId,
      workspaceId: workspaceSources.workspaceId,
      provider: workspaceSources.provider,
      state: workspaceSources.state,
    })
    .from(workspaceSources)
    .where(
      and(
        eq(workspaceSources.provider, "github"),
        filter.orgId ? eq(workspaceSources.orgId, filter.orgId) : undefined,
        filter.workspaceId
          ? eq(workspaceSources.workspaceId, filter.workspaceId)
          : undefined,
      ),
    )
    .orderBy(workspaceSources.sourceKey)
  return rows
    .flatMap((row) => githubPins(row).map((pin) => toLinked(row, pin)))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

/** The linked repository with one link id, or null. */
export async function getLinkedRepositoryPin(
  db: Queryable,
  linkId: string,
): Promise<LinkedRepositoryPin | null> {
  const rows = await db
    .select({
      id: workspaceSources.id,
      orgId: workspaceSources.orgId,
      workspaceId: workspaceSources.workspaceId,
      provider: workspaceSources.provider,
      state: workspaceSources.state,
    })
    .from(workspaceSources)
    .where(linkPredicate(linkId))
  for (const row of rows) {
    const pin = githubPins(row).find((item) => item.id === linkId)
    if (pin) return toLinked(row, pin)
  }
  return null
}

function linkPredicate(linkId: string) {
  return and(
    eq(workspaceSources.provider, "github"),
    sql`${workspaceSources.state}->'repositories' @> ${JSON.stringify([{ id: linkId }])}::jsonb`,
  )
}

/**
 * Change the pin with one link id under a row lock. `change` sees the
 * current pin and returns the new SHAs, or null to keep the row. Returns
 * true when the row changed.
 */
export async function updateLinkedRepositoryPin(
  db: Db,
  linkId: string,
  change: (
    pin: LinkedRepositoryPin,
    tx: Tx,
  ) => Promise<Partial<
    Pick<GithubRepositoryPin, "desiredSha" | "indexedSha">
  > | null>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: workspaceSources.id,
        orgId: workspaceSources.orgId,
        workspaceId: workspaceSources.workspaceId,
        provider: workspaceSources.provider,
        state: workspaceSources.state,
      })
      .from(workspaceSources)
      .where(linkPredicate(linkId))
      .for("update")
    for (const row of rows) {
      const pins = githubPins(row)
      const index = pins.findIndex((pin) => pin.id === linkId)
      const current = pins[index]
      if (!current) continue
      const patch = await change(toLinked(row, current), tx)
      if (!patch) return false
      const next = pins.slice()
      next[index] = { ...current, ...patch }
      await tx
        .update(workspaceSources)
        .set({
          state: {
            provider: "github",
            repositories: next,
          } satisfies SourceState,
        })
        .where(eq(workspaceSources.id, row.id))
      return true
    }
    return false
  })
}

/** Clear the SHAs of every pin whose URL is in `gitUrls` (normalized). */
export async function clearLinkedRepositoryShas(
  db: Db,
  gitUrls: ReadonlySet<string>,
  normalize: (url: string) => string,
): Promise<void> {
  if (gitUrls.size === 0) return
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: workspaceSources.id,
        provider: workspaceSources.provider,
        state: workspaceSources.state,
      })
      .from(workspaceSources)
      .where(eq(workspaceSources.provider, "github"))
      .for("update")
    for (const row of rows) {
      const pins = githubPins(row)
      if (!pins.some((pin) => gitUrls.has(normalize(pin.gitUrl)))) continue
      await tx
        .update(workspaceSources)
        .set({
          state: {
            provider: "github",
            repositories: pins.map((pin) =>
              gitUrls.has(normalize(pin.gitUrl))
                ? { ...pin, desiredSha: null, indexedSha: null }
                : pin,
            ),
          } satisfies SourceState,
        })
        .where(eq(workspaceSources.id, row.id))
    }
  })
}
