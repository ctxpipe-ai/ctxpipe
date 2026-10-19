import { isDeepStrictEqual } from "node:util"
import { and, eq, inArray, type SQL, sql } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { z } from "zod"
import type { Db } from "../db/client.js"
import { workspaceSources } from "../db/schema/workspace_sources.js"
import { linkingOrder } from "../domain/workspace-sources/github-sources.js"
import { sourceRepositoryUrls } from "../domain/workspace-sources/providers/git.js"
import { githubSourceScopeRepositories } from "../domain/workspace-sources/providers/github.js"
import type { SourceStatus } from "../domain/workspace-sources/sources-file.js"
import { normalizeWorkspaceRepositoryUrl } from "../domain/workspaces/slug.js"
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
type GithubSourceState = Extract<SourceState, { provider: "github" }>

export const sourceTargetSchema = z.object({
  provider: z.string().min(1),
  /** Null only for a plain git source, which has no connection (CTX-815). */
  connectionId: z.string().min(1).nullable(),
  scope: z.record(z.string(), z.unknown()),
})

/** The provider, connection and scope of one source entry. */
export type SourceTarget = z.infer<typeof sourceTargetSchema>

/**
 * The stored state of one row: the provider state, and only on an `invalid`
 * row the key `lastGoodTarget`. That key holds the target of the last valid
 * entry of the source, because the files of that target can be in git. A
 * later removal or change of the source cleans them up. A stored target that
 * does not parse stays as it is, so that the row keeps its files.
 */
export type StoredSourceState = (SourceState | { provider?: never }) & {
  lastGoodTarget?: unknown
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Queryable = Db | Tx

/** Parse the state of one row. An empty or invalid state gives null. */
export function parseSourceState(row: {
  id: string
  provider: string | null
  state: unknown
}): SourceState | null {
  const state = withoutTarget(row.state)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function withoutTarget(state: unknown): unknown {
  if (!isRecord(state) || !("lastGoodTarget" in state)) return state
  const { lastGoodTarget: _target, ...rest } = state
  return rest
}

/** The `lastGoodTarget` key of a stored state as stored, or null. */
function storedTarget(state: unknown): unknown {
  return isRecord(state) ? (state.lastGoodTarget ?? null) : null
}

/** The columns of a source row that give its last good target. */
type SourceTargetRow = {
  id: string
  provider: string | null
  connectionId: string | null
  scope: Record<string, unknown>
  status: string
  state: unknown
}

/**
 * The provider, connection and scope of the last valid entry of a source, or
 * null when it had none. The files of this target can be in git. A valid row
 * is its own target. An `invalid` row keeps the target in its state.
 */
export function lastGoodTarget(row: SourceTargetRow): SourceTarget | null {
  if (row.status === "invalid")
    return sourceTargetSchema.safeParse(storedTarget(row.state)).data ?? null
  if (
    row.provider === null ||
    (row.connectionId === null && row.provider !== "git")
  )
    return null
  return {
    provider: row.provider,
    connectionId: row.connectionId,
    scope: row.scope,
  }
}

/**
 * Tell if a row holds the files of a target: a valid row holds its own, an
 * `invalid` row holds its stored `lastGoodTarget`, also when that key does
 * not parse.
 */
export function holdsTarget(row: SourceTargetRow): boolean {
  return row.status === "invalid"
    ? storedTarget(row.state) !== null
    : lastGoodTarget(row) !== null
}

/**
 * Tell if a stored source row names the repository `gitUrl` in any form: its
 * own scope, its last good target, or its GitHub pins. An `invalid` row whose
 * stored target does not parse can hold any repository, so it names each one
 * (the CTX-710 rule: an entry that became invalid keeps its repository).
 */
export function sourceRowsNameRepository(
  rows: readonly SourceTargetRow[],
  gitUrl: string,
): boolean {
  const target = normalizeWorkspaceRepositoryUrl(gitUrl)
  return rows.some((row) => {
    const good = lastGoodTarget(row)
    if (holdsTarget(row) && !good) return true
    return (
      sourceRepositoryUrls(row).includes(target) ||
      (good !== null && sourceRepositoryUrls(good).includes(target)) ||
      githubPins(row).some(
        (pin) => normalizeWorkspaceRepositoryUrl(pin.gitUrl) === target,
      )
    )
  })
}

/** A GitHub state with `repositories` that keeps the target of `row`. */
function withPins(
  row: { state: unknown },
  repositories: GithubRepositoryPin[],
): StoredSourceState {
  const target = storedTarget(row.state)
  return {
    provider: "github",
    repositories,
    ...(target !== null ? { lastGoodTarget: target } : {}),
  }
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
 * The next GitHub state for the repositories that the sources want. A
 * repository with the same URL and ref keeps its id and SHAs. A new
 * repository, or one with a changed ref, gets a new id and no SHAs.
 */
export function reconcileGithubState(
  previous: readonly GithubRepositoryPin[],
  wanted: ReadonlyArray<{ gitUrl: string; ref: string | null }>,
  now: Date = new Date(),
): GithubSourceState {
  return {
    provider: "github",
    repositories: wanted.map(({ gitUrl, ref }) => {
      const current = previous.find(
        (pin) => pin.gitUrl === gitUrl && pin.ref === ref,
      )
      if (current) return current
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

/** A row status whose connection can read the linked repositories. */
const LINKING_SOURCE_STATUSES = ["ok", "out_of_access"] as const

/**
 * A row status whose linked repositories the product serves: MCP, chat, and
 * sandbox checkouts read only these. An `out_of_access` row means that the
 * customer took back our access, so its cached code is not served. The row
 * keeps its pins, so a link keeps its id and SHAs when access comes back.
 */
const SERVING_SOURCE_STATUSES = ["ok"] as const

/**
 * The next state of each planned row of one Workspace, by source key. The
 * pins of a repository belong to the repository, not to the row: a
 * repository keeps its id and SHAs when it moves to another entry, and a row
 * whose connection is missing or whose entry is invalid keeps its pins and
 * the pins of the repositories that its scope names (they link nothing while
 * the row cannot link) until the row recovers. A
 * repository is linked only once: the Workspace repository and a repository
 * of an earlier row are not linked again. An `invalid` row keeps the last
 * good target of its source (see {@link lastGoodTarget}).
 */
export function planSourceStates(input: {
  existing: ReadonlyArray<SourceTargetRow & { sourceKey: string }>
  planned: ReadonlyArray<{
    sourceKey: string
    provider: string | null
    status: string
    scope: unknown
  }>
  workspaceUrl: string | null
  /**
   * The old key of a row whose source moved to a new key, by new key. The new
   * row takes the pins and the held target of the old row, when no planned
   * row has the old key.
   */
  movedFrom?: ReadonlyMap<string, string>
  now?: Date
}): Map<string, StoredSourceState> {
  const byKey = new Map(
    input.existing.map((row) => [
      row.sourceKey,
      { row, pins: githubPins(row) },
    ]),
  )
  const plannedKeys = new Set(input.planned.map((row) => row.sourceKey))
  const rowOf = (sourceKey: string) => {
    const own = byKey.get(sourceKey)
    if (own) return own
    const old = input.movedFrom?.get(sourceKey)
    return old !== undefined && !plannedKeys.has(old)
      ? byKey.get(old)
      : undefined
  }
  // A pin belongs to its repository URL and ref, not to a row or a path, so
  // a renamed source file keeps its pin (ADR-050, revision 2026-10-16).
  const pool = new Map<string, GithubRepositoryPin>()
  for (const { pins } of byKey.values())
    for (const pin of pins) {
      const key = `${pin.gitUrl} ${pin.ref ?? ""}`
      if (!pool.has(key)) pool.set(key, pin)
    }
  const linked = new Set<string>(
    input.workspaceUrl
      ? [normalizeWorkspaceRepositoryUrl(input.workspaceUrl)]
      : [],
  )
  const states = new Map<string, StoredSourceState>()
  const linking = (status: string) =>
    (LINKING_SOURCE_STATUSES as readonly string[]).includes(status)
  for (const planned of linkingOrder(input.planned)) {
    if (planned.provider !== "github") {
      states.set(planned.sourceKey, {})
      continue
    }
    if (!linking(planned.status)) continue
    const wanted = githubSourceScopeRepositories(planned.scope).flatMap(
      ({ name, ref }) => {
        const gitUrl = normalizeWorkspaceRepositoryUrl(
          `https://github.com/${name}`,
        )
        if (linked.has(gitUrl)) return []
        linked.add(gitUrl)
        return [{ gitUrl, ref }]
      },
    )
    states.set(
      planned.sourceKey,
      reconcileGithubState([...pool.values()], wanted, input.now),
    )
  }
  // A row that cannot link keeps its own pins and the pins of the
  // repositories that its scope names (by URL and ref), so a file that is
  // renamed and invalid at the same revision keeps its pin. Each pin goes to
  // one row only. An `invalid` row also keeps the last good target.
  const kept = new Set<string>()
  for (const planned of input.planned) {
    const current = rowOf(planned.sourceKey)
    if (planned.provider === "github" && !linking(planned.status)) {
      const named = new Set(
        githubSourceScopeRepositories(planned.scope).map(
          ({ name, ref }) =>
            `${normalizeWorkspaceRepositoryUrl(`https://github.com/${name}`)} ${ref ?? ""}`,
        ),
      )
      const repositories = [
        ...(current?.pins ?? []),
        ...[...pool.entries()].flatMap(([key, pin]) =>
          named.has(key) ? [pin] : [],
        ),
      ].filter((pin) => {
        if (linked.has(pin.gitUrl) || kept.has(pin.id)) return false
        kept.add(pin.id)
        return true
      })
      states.set(planned.sourceKey, { provider: "github", repositories })
    }
    if (planned.status !== "invalid" || !current) continue
    const target = heldTargetOf(current.row)
    if (target !== null)
      states.set(planned.sourceKey, {
        ...(states.get(planned.sourceKey) ?? {}),
        lastGoodTarget: target,
      })
  }
  return states
}

/**
 * The target that an `invalid` row keeps from its current row. A stored
 * target that does not parse stays as it is, and the projection logs it.
 */
function heldTargetOf(current: SourceTargetRow): unknown {
  const target =
    current.status === "invalid"
      ? storedTarget(current.state)
      : lastGoodTarget(current)
  if (target !== null && !sourceTargetSchema.safeParse(target).success)
    log.warn({
      step: "workspace_sources.state_invalid",
      sourceId: current.id,
      message: "The last good target does not parse; the row keeps it",
    })
  return target
}

/** The same state. jsonb does not keep the key order, so compare by value. */
export function sameSourceState(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b)
}

/**
 * A jsonb select value: the state of each serving GitHub row of the
 * Workspace with the id `workspaceId`. Read it with {@link linkedSourcePins}.
 */
export function servedSourceStatesSql(workspaceId: SQL) {
  const column = (name: AnyPgColumn) =>
    sql`${workspaceSources}.${sql.identifier(name.name)}`
  return sql<LinkedSourceStates>`coalesce((
    select jsonb_agg(jsonb_build_object('id', ${column(workspaceSources.id)}, 'provider', ${column(workspaceSources.provider)}, 'state', ${column(workspaceSources.state)}))
    from ${workspaceSources}
    where ${column(workspaceSources.workspaceId)} = ${workspaceId}
    and ${column(workspaceSources.provider)} = 'github'
    and ${column(workspaceSources.status)} in (${sql.join(
      SERVING_SOURCE_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    )})
  ), '[]'::jsonb)`
}

type LinkedSourceStates = Array<{
  id: string
  provider: string | null
  state: unknown
}>

/** The pins of the value of {@link servedSourceStatesSql}. */
export function linkedSourcePins(
  rows: LinkedSourceStates,
): GithubRepositoryPin[] {
  return rows.flatMap(githubPins)
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
export function listLinkedRepositoryPins(
  db: Queryable,
  filter: { orgId?: string; workspaceId?: string } = {},
): Promise<LinkedRepositoryPin[]> {
  return listPins(db, filter, LINKING_SOURCE_STATUSES)
}

/**
 * The linked repositories that the product serves (MCP, chat, sandbox
 * checkouts): the pins of `ok` rows only. Arguments as for
 * {@link listLinkedRepositoryPins}.
 */
export function listServedRepositoryPins(
  db: Queryable,
  filter: { orgId?: string; workspaceId?: string } = {},
): Promise<LinkedRepositoryPin[]> {
  return listPins(db, filter, SERVING_SOURCE_STATUSES)
}

async function listPins(
  db: Queryable,
  filter: { orgId?: string; workspaceId?: string },
  statuses: readonly SourceStatus[],
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
        // A row that cannot link keeps its pins, but they link nothing.
        inArray(workspaceSources.status, [...statuses]),
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
        .set({ state: withPins(row, next) })
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
          state: withPins(
            row,
            pins.map((pin) =>
              gitUrls.has(normalize(pin.gitUrl))
                ? { ...pin, desiredSha: null, indexedSha: null }
                : pin,
            ),
          ),
        })
        .where(eq(workspaceSources.id, row.id))
    }
  })
}
