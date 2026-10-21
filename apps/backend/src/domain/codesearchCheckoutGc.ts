import { and, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import { signUpstreamJwt } from "../auth/upstreamJwt.js"
import { parseEnv } from "../config/env.js"
import {
  assertNotInOrgDbContext,
  getSystemDb,
  withOrgDbContext,
} from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import { formatUnknownError } from "../db/transientDbRetry.js"
import { codesearchBaseUrl } from "../lib/agentToolRuntime.js"
import { log } from "../observability/logger.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"

/** Keys per codesearch call (the codesearch request limit). */
const BATCH = 50
/** Calls per repository in one collection, so one run stays bounded. */
const MAX_BATCHES = 20

const SHA = "[0-9a-f]{40}(?:[0-9a-f]{24})?"

/**
 * The checkouts of an org that no reader needs. Only `rev:<sha>` and
 * `ws:<id>:<sha>` keys are candidates; `default` and other shapes stay. A
 * candidate stays when:
 * - it is the published revision of its repository (`rev:<last_ingested_hash>`),
 * - its SHA is in the input or a step output of an unfinished workflow run, or
 *   of a child run of one (a running ingestion or index job),
 * - it is a `ws:<id>:<sha>` key and the Workspace row or its source rows hold
 *   the SHA (the active, desired, indexed, and linked revisions),
 * - its row changed in the last hour (a run that has only just started).
 *
 * A conversation sandbox reads only the current Workspace checkouts, so the
 * Workspace rule keeps what chat reads. Run inside the org context (RLS).
 */
export async function listCollectableCheckouts(
  orgId: string,
  repositoryId?: string,
  limit = BATCH,
): Promise<Array<{ repositoryId: string; checkoutKey: string }>> {
  const ns = openWorkflowNamespaceId()
  const result = await withOrgDbContext(orgId, (db) =>
    db.execute<{ repository_id: string; checkout_key: string }>(sql`
      with recursive live(id) as (
        select id from openworkflow.workflow_runs
        where namespace_id = ${ns} and status in ('pending', 'running', 'sleeping')
        union
        select sa.child_workflow_run_id from openworkflow.step_attempts sa
        join live on sa.workflow_run_id = live.id
        where sa.namespace_id = ${ns} and sa.child_workflow_run_id is not null
      ),
      live_text(body) as (
        select r.input::text from openworkflow.workflow_runs r
        join live on live.id = r.id
        where r.namespace_id = ${ns} and r.input is not null
        union all
        select sa.output::text from openworkflow.step_attempts sa
        join live on live.id = sa.workflow_run_id
        where sa.namespace_id = ${ns} and sa.output is not null
      ),
      live_shas(sha) as (
        select distinct m[1] from live_text
        cross join lateral regexp_matches(live_text.body, ${`(${SHA})`}, 'g') as m
      )
      select c.repository_id, c.checkout_key
      from repository_checkouts c
      join repositories r on r.id = c.repository_id
      where c.checkout_key ~ ${`^(rev:${SHA}|ws:[A-Za-z0-9_-]+:${SHA})$`}
        and greatest(c.created_at, c.updated_at) < now() - interval '1 hour'
        and c.checkout_key <> ('rev:' || coalesce(r.last_ingested_hash, ''))
        and not exists (
          select 1 from live_shas l where c.checkout_key like ('%:' || l.sha)
        )
        and not exists (
          select 1 from workspaces w
          where starts_with(c.checkout_key, 'ws:' || w.id || ':')
            and strpos(
              to_jsonb(w)::text || coalesce((
                select string_agg(to_jsonb(s)::text, '')
                from workspace_sources s where s.workspace_id = w.id
              ), ''),
              split_part(c.checkout_key, ':', 3)
            ) > 0
        )
        ${repositoryId ? sql`and c.repository_id = ${repositoryId}` : sql``}
      order by c.repository_id, c.updated_at
      limit ${limit}
    `),
  )
  return result.rows.map((row) => ({
    repositoryId: row.repository_id,
    checkoutKey: row.checkout_key,
  }))
}

const deleteResponseSchema = z.object({
  deleted: z.array(z.object({ checkoutKey: z.string(), bytes: z.number() })),
  skipped: z.array(z.object({ checkoutKey: z.string(), reason: z.string() })),
})

async function deleteOnCodesearch(
  orgId: string,
  repositoryId: string,
  checkoutKeys: string[],
): Promise<z.infer<typeof deleteResponseSchema> | "busy"> {
  assertNotInOrgDbContext()
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const token = await signUpstreamJwt({
    env,
    audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
    claims: { sub: `repo-gc:${repositoryId}`, orgId, principal: "service" },
  })
  const response = await fetch(
    `${codesearchBaseUrl()}/${repositoryId}/checkouts/delete`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ checkoutKeys }),
    },
  )
  if (response.status === 409) {
    await response.body?.cancel()
    return "busy"
  }
  if (!response.ok)
    throw new Error(
      `codesearch checkout delete failed: ${response.status} ${(await response.text()).slice(0, 300)}`,
    )
  return deleteResponseSchema.parse(await response.json())
}

/**
 * Deletes the checkouts of one repository that no reader needs: first the
 * files on codesearch, then the rows of the keys that codesearch deleted.
 * Never throws; a failure is logged and the next run tries again.
 */
export async function collectRepositoryCheckouts(input: {
  orgId: string
  repositoryId: string
}): Promise<{ deletedKeys: number; bytesFreed: number }> {
  let deletedKeys = 0
  let bytesFreed = 0
  try {
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const keys = (
        await listCollectableCheckouts(input.orgId, input.repositoryId)
      ).map((row) => row.checkoutKey)
      if (!keys.length) break
      const result = await deleteOnCodesearch(
        input.orgId,
        input.repositoryId,
        keys,
      )
      if (result === "busy") break
      const deleted = result.deleted.map((d) => d.checkoutKey)
      if (deleted.length)
        await withOrgDbContext(input.orgId, (db) =>
          db
            .delete(repositoryCheckouts)
            .where(
              and(
                eq(repositoryCheckouts.repositoryId, input.repositoryId),
                inArray(repositoryCheckouts.checkoutKey, deleted),
              ),
            ),
        )
      const bytes = result.deleted.reduce((sum, d) => sum + d.bytes, 0)
      deletedKeys += deleted.length
      bytesFreed += bytes
      log.info({
        step: "codesearch-checkout-gc.repository",
        message: `Deleted ${deleted.length} old checkouts (${bytes} bytes)`,
        orgId: input.orgId,
        repositoryId: input.repositoryId,
        deletedKeys: deleted.join(","),
        skippedKeys: result.skipped.map((s) => s.checkoutKey).join(","),
        bytesFreed: bytes,
      })
      // Skipped keys stay in the list, so stop to not ask for them again.
      if (keys.length < BATCH || result.skipped.length) break
    }
  } catch (error) {
    log.error({
      step: "codesearch-checkout-gc.repository",
      message: `Deleting old checkouts failed: ${formatUnknownError(error)}`,
      orgId: input.orgId,
      repositoryId: input.repositoryId,
    })
  }
  return { deletedKeys, bytesFreed }
}

/** Collects the old checkouts of every repository of every org. */
export async function collectAllCheckouts(): Promise<{
  repositories: number
  deletedKeys: number
  bytesFreed: number
}> {
  const totals = { repositories: 0, deletedKeys: 0, bytesFreed: 0 }
  const orgs = await getSystemDb()
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(organizations.id)
  for (const { id: orgId } of orgs) {
    let repositoryIds: string[]
    try {
      repositoryIds = [
        ...new Set(
          (await listCollectableCheckouts(orgId, undefined, 10_000)).map(
            (row) => row.repositoryId,
          ),
        ),
      ]
    } catch (error) {
      log.error({
        step: "codesearch-checkout-gc.org",
        message: `Listing old checkouts failed: ${formatUnknownError(error)}`,
        orgId,
      })
      continue
    }
    for (const repositoryId of repositoryIds) {
      const result = await collectRepositoryCheckouts({ orgId, repositoryId })
      totals.repositories += 1
      totals.deletedKeys += result.deletedKeys
      totals.bytesFreed += result.bytesFreed
    }
  }
  log.info({
    step: "codesearch-checkout-gc.all",
    message: `Deleted ${totals.deletedKeys} old checkouts in ${totals.repositories} repositories (${totals.bytesFreed} bytes)`,
    ...totals,
  })
  return totals
}
