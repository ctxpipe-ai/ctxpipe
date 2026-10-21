import { type SQL, sql } from "drizzle-orm"
import { z } from "zod"
import { signUpstreamJwt } from "../auth/upstreamJwt.js"
import { parseEnv } from "../config/env.js"
import {
  assertNotInOrgDbContext,
  getSystemDb,
  withOrgDbContext,
} from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { formatUnknownError } from "../db/transientDbRetry.js"
import { codesearchBaseUrl } from "../lib/agentToolRuntime.js"
import { log } from "../observability/logger.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"
import {
  INGESTION_SHARD_WORKFLOW_NAME,
  INGESTION_V2_WORKFLOW_NAME,
} from "./ingestion/ingestion-run.js"

/**
 * Keys per codesearch call. Each key is a recursive delete on codesearch, so
 * a small batch keeps one call short (the HTTP idle timeout) and does not
 * hold the purge lock of the repository for long.
 */
const BATCH = 10
/** Calls per repository in one collection, so one run stays bounded. */
const MAX_BATCHES = 50

const SHA = "[0-9a-f]{40}(?:[0-9a-f]{24})?"

/**
 * The SHAs of the unfinished workflow runs that can read a checkout: the
 * input and the latest output of each step of an ingestion, index, or
 * hydrate run. A child run of one of these is of one of these workflows too.
 */
function liveShasQuery(): SQL {
  const ns = openWorkflowNamespaceId()
  const workflows = [
    "repository-ingestion",
    "repository-ingestion-orchestrator",
    INGESTION_V2_WORKFLOW_NAME,
    INGESTION_SHARD_WORKFLOW_NAME,
    "repository-index",
    "workspace-index",
    "workspace-hydrate",
  ]
  return sql`
    with live as (
      select id, input from openworkflow.workflow_runs
      where namespace_id = ${ns}
        and status in ('pending', 'running', 'sleeping')
        and workflow_name in (${sql.join(
          workflows.map((name) => sql`${name}`),
          sql`, `,
        )})
    ),
    live_text(body) as (
      select input::text from live where input is not null
      union all
      -- In parentheses, so that the order applies to this branch only.
      (
        select distinct on (sa.workflow_run_id, sa.step_name) sa.output::text
        from openworkflow.step_attempts sa
        join live on live.id = sa.workflow_run_id
        where sa.namespace_id = ${ns} and sa.output is not null
        order by sa.workflow_run_id, sa.step_name, sa.created_at desc
      )
    )
    select distinct m[1] as sha from live_text
    cross join lateral regexp_matches(live_text.body, ${`(${SHA})`}, 'g') as m
  `
}

/** The SHAs that unfinished runs can still read (see `liveShasQuery`). */
export async function listLiveShas(): Promise<string[]> {
  const result = await getSystemDb().execute<{ sha: string }>(liveShasQuery())
  return result.rows.map((row) => row.sha)
}

/**
 * The checkouts (alias `c`, with its repository `r`) that no reader needs.
 * Only `rev:<sha>` and `ws:<id>:<sha>` keys are candidates; `default` and
 * other shapes stay. A candidate stays when:
 * - it is the published revision of its repository (`rev:<last_ingested_hash>`),
 * - its SHA is in `liveShas` (a running ingestion or index job),
 * - it is a `ws:<id>:<sha>` key and the Workspace row or its source rows hold
 *   the SHA (the active, desired, indexed, and linked revisions),
 * - its row changed in the last hour. A run touches the row when it starts
 *   to use the key, so a run that has only just started keeps its key.
 *
 * Chat tools read the current Workspace projection on each call, so the
 * Workspace rule keeps what chat reads. A call that started on the revision
 * before keeps it through the one-hour window.
 */
function collectable(liveShas: SQL): SQL {
  return sql`
    c.checkout_key ~ ${`^(rev:${SHA}|ws:[A-Za-z0-9_-]+:${SHA})$`}
    and greatest(c.created_at, c.updated_at) < now() - interval '1 hour'
    and c.checkout_key <> ('rev:' || coalesce(r.last_ingested_hash, ''))
    and not (regexp_replace(c.checkout_key, '^.*:', '') = any(${liveShas}))
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
  `
}

const textArray = (values: string[]) =>
  sql`string_to_array(${values.join(",")}, ',')`

/** The repositories of an org that have a checkout to collect. */
async function listCandidateRepositories(
  orgId: string,
  liveShas: string[],
): Promise<string[]> {
  const result = await withOrgDbContext(orgId, (db) =>
    db.execute<{ repository_id: string }>(sql`
      select distinct c.repository_id
      from repository_checkouts c
      join repositories r on r.id = c.repository_id
      where ${collectable(textArray(liveShas))}
      order by c.repository_id
    `),
  )
  return result.rows.map((row) => row.repository_id)
}

/**
 * The checkout keys of one repository that no reader needs, oldest first,
 * without the keys in `exclude`. Run inside the org context (RLS).
 */
export async function listCollectableCheckouts(input: {
  orgId: string
  repositoryId: string
  liveShas: string[]
  exclude?: string[]
}): Promise<string[]> {
  const result = await withOrgDbContext(input.orgId, (db) =>
    db.execute<{ checkout_key: string }>(sql`
      select c.checkout_key
      from repository_checkouts c
      join repositories r on r.id = c.repository_id
      where c.repository_id = ${input.repositoryId}
        and ${collectable(textArray(input.liveShas))}
        and not (c.checkout_key = any(${textArray(input.exclude ?? [])}))
      order by c.updated_at, c.checkout_key
      limit ${BATCH}
    `),
  )
  return result.rows.map((row) => row.checkout_key)
}

/**
 * Deletes the rows of `checkoutKeys` that are still collectable now: the
 * live SHAs, the published revision, the Workspace rows, and the one-hour
 * window are read again in the same statement. A run that started to use a
 * key after the list touched its row, so that row stays.
 */
async function deleteCollectableRows(
  orgId: string,
  repositoryId: string,
  checkoutKeys: string[],
): Promise<string[]> {
  const result = await withOrgDbContext(orgId, (db) =>
    db.execute<{ checkout_key: string }>(sql`
      delete from repository_checkouts c
      using repositories r
      where r.id = c.repository_id
        and c.repository_id = ${repositoryId}
        and c.checkout_key = any(${textArray(checkoutKeys)})
        and ${collectable(sql`array(${liveShasQuery()})`)}
      returning c.checkout_key
    `),
  )
  return result.rows.map((row) => row.checkout_key)
}

const deleteResponseSchema = z.object({
  deleted: z.array(z.object({ checkoutKey: z.string() })),
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
 * files on codesearch, then the rows of the keys that codesearch deleted and
 * that are still collectable. `liveShas` comes from the caller when it
 * collects many repositories; otherwise this reads it once.
 * Never throws; a failure is logged and the next run tries again.
 */
export async function collectRepositoryCheckouts(input: {
  orgId: string
  repositoryId: string
  liveShas?: string[]
}): Promise<{ deletedKeys: number }> {
  let deletedKeys = 0
  try {
    const liveShas = input.liveShas ?? (await listLiveShas())
    // Codesearch kept these in this pass; do not ask for them again.
    const skipped: string[] = []
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const keys = await listCollectableCheckouts({
        orgId: input.orgId,
        repositoryId: input.repositoryId,
        liveShas,
        exclude: skipped,
      })
      if (!keys.length) break
      const result = await deleteOnCodesearch(
        input.orgId,
        input.repositoryId,
        keys,
      )
      if (result === "busy") break
      skipped.push(...result.skipped.map((s) => s.checkoutKey))
      const filesDeleted = result.deleted.map((d) => d.checkoutKey)
      const rowsDeleted = filesDeleted.length
        ? await deleteCollectableRows(
            input.orgId,
            input.repositoryId,
            filesDeleted,
          )
        : []
      // A key that a run took again after the list keeps its row; the run
      // indexes its files again.
      skipped.push(...filesDeleted.filter((key) => !rowsDeleted.includes(key)))
      deletedKeys += rowsDeleted.length
      log.info({
        step: "codesearch-checkout-gc.repository",
        message: `Deleted ${rowsDeleted.length} old checkouts`,
        orgId: input.orgId,
        repositoryId: input.repositoryId,
        deletedKeys: rowsDeleted.join(","),
        skippedKeys: result.skipped.map((s) => s.checkoutKey).join(","),
      })
      if (keys.length < BATCH) break
    }
  } catch (error) {
    log.error({
      step: "codesearch-checkout-gc.repository",
      message: `Deleting old checkouts failed: ${formatUnknownError(error)}`,
      orgId: input.orgId,
      repositoryId: input.repositoryId,
    })
  }
  return { deletedKeys }
}

/**
 * Collects the old checkouts of every repository of every org. It reads the
 * live SHAs once for the pass.
 */
export async function collectAllCheckouts(): Promise<{
  repositories: number
  deletedKeys: number
}> {
  const totals = { repositories: 0, deletedKeys: 0 }
  const liveShas = await listLiveShas()
  const orgs = await getSystemDb()
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(organizations.id)
  for (const { id: orgId } of orgs) {
    let repositoryIds: string[]
    try {
      repositoryIds = await listCandidateRepositories(orgId, liveShas)
    } catch (error) {
      log.error({
        step: "codesearch-checkout-gc.org",
        message: `Listing old checkouts failed: ${formatUnknownError(error)}`,
        orgId,
      })
      continue
    }
    for (const repositoryId of repositoryIds) {
      const result = await collectRepositoryCheckouts({
        orgId,
        repositoryId,
        liveShas,
      })
      totals.repositories += 1
      totals.deletedKeys += result.deletedKeys
    }
  }
  log.info({
    step: "codesearch-checkout-gc.all",
    message: `Deleted ${totals.deletedKeys} old checkouts in ${totals.repositories} repositories`,
    ...totals,
  })
  return totals
}
