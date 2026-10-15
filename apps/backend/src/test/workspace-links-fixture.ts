import { and, eq } from "drizzle-orm"
import { requireCurrentOrgId } from "../auth/context.js"
import { type Db, getOrgDb } from "../db/client.js"
import { workspaceSources } from "../db/schema/workspace_sources.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../domain/workspaces/write-status.js"
import { generateObjectId } from "../lib/id.js"
import {
  type GithubRepositoryPin,
  githubPins,
  planSourceStates,
  type SourceState,
} from "../models/workspace-source-state.js"
import { orgSql } from "../models/workspace-sql.js"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** One linked repository, in the shape of the old table row. */
export type LinkedRepositoryFixture = {
  id?: string
  orgId: string
  workspaceId: string
  gitUrl: string
  desiredRef?: string | null
  desiredSha?: string | null
  indexedSha?: string | null
  createdAt?: Date
}

/**
 * Link repositories the way the sources projection does: append pins to the
 * state of the `linked-repositories` GitHub source row of each Workspace.
 * Tests use it where they have no `.ctxpipe/sources.yaml` to project.
 */
export async function insertLinkedRepositoryRows(
  db: Db | Tx,
  input: LinkedRepositoryFixture | LinkedRepositoryFixture[],
): Promise<void> {
  for (const row of Array.isArray(input) ? input : [input]) {
    const pin: GithubRepositoryPin = {
      id: row.id ?? generateObjectId("wlr"),
      gitUrl: row.gitUrl,
      ref: row.desiredRef ?? null,
      desiredSha: row.desiredSha ?? null,
      indexedSha: row.indexedSha ?? null,
      createdAt: (row.createdAt ?? new Date()).toISOString(),
    }
    const [current] = await db
      .select()
      .from(workspaceSources)
      .where(
        and(
          eq(workspaceSources.workspaceId, row.workspaceId),
          eq(workspaceSources.sourceKey, "linked-repositories"),
        ),
      )
    const pins = current ? [...githubPins(current), pin] : [pin]
    const state: SourceState = { provider: "github", repositories: pins }
    const names = pins.flatMap(
      (item) => githubRepoFullNameFromWorkspaceUrl(item.gitUrl) ?? [],
    )
    const scope = names.length ? { repositories: names } : {}
    if (current)
      await db
        .update(workspaceSources)
        .set({ state, scope })
        .where(eq(workspaceSources.id, current.id))
    else
      await db.insert(workspaceSources).values({
        id: generateObjectId("wsrc"),
        orgId: row.orgId,
        workspaceId: row.workspaceId,
        sourceKey: "linked-repositories",
        connectionId: null,
        provider: "github",
        scope,
        status: "ok",
        statusDetail: null,
        revision: "fixture",
        state,
      })
  }
}

/**
 * Insert `workspace_sources` rows with the state that the sources projection
 * gives them, so a GitHub row links the repositories of its scope. Tests use
 * it where they have no `.ctxpipe/sources.yaml` to project.
 */
export async function insertProjectedSourceRows(
  db: Db | Tx,
  rows: Array<typeof workspaceSources.$inferInsert>,
): Promise<void> {
  const states = new Map<string, SourceState | Record<string, never>>()
  for (const workspaceId of new Set(rows.map((row) => row.workspaceId))) {
    const planned = rows
      .filter((row) => row.workspaceId === workspaceId)
      .map((row) => ({
        sourceKey: row.sourceKey,
        provider: row.provider ?? null,
        status: row.status,
        scope: row.scope ?? {},
      }))
    for (const [sourceKey, state] of planSourceStates({
      existing: [],
      planned,
      workspaceUrl: null,
    }))
      states.set(`${workspaceId} ${sourceKey}`, state)
  }
  await db.insert(workspaceSources).values(
    rows.map((row) => ({
      ...row,
      state: states.get(`${row.workspaceId} ${row.sourceKey}`) ?? {},
    })),
  )
}

/** Link repositories in the current org context. */
export async function insertWorkspaceLinks(
  links: Array<{ workspaceId: string; gitUrl: string }>,
): Promise<void> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const present = new Set(
      (
        await db
          .select()
          .from(workspaceSources)
          .where(eq(workspaceSources.orgId, orgId))
      ).flatMap((row) =>
        githubPins(row).map((pin) => `${row.workspaceId} ${pin.gitUrl}`),
      ),
    )
    for (const link of links) {
      if (present.has(`${link.workspaceId} ${link.gitUrl}`)) continue
      present.add(`${link.workspaceId} ${link.gitUrl}`)
      await insertLinkedRepositoryRows(db, { orgId, ...link })
    }
  })
}

/** Change the ref of one pin in place, as a concurrent relink would. */
export async function setLinkedRepositoryRef(
  db: Db | Tx,
  linkId: string,
  ref: string | null,
): Promise<void> {
  for (const row of await db.select().from(workspaceSources)) {
    const pins = githubPins(row)
    if (!pins.some((pin) => pin.id === linkId)) continue
    await db
      .update(workspaceSources)
      .set({
        state: {
          provider: "github",
          repositories: pins.map((pin) =>
            pin.id === linkId ? { ...pin, ref } : pin,
          ),
        } satisfies SourceState,
      })
      .where(eq(workspaceSources.id, row.id))
  }
}
