import { type SQL, sql } from "drizzle-orm"
import { z } from "zod"
import { repositoryRevisionCheckoutKey } from "../../../../shared/workspace-checkout.js"
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
function liveShasQuery(exceptRunId?: string): SQL {
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
        ${exceptRunId ? sql`and id <> ${exceptRunId}` : sql``}
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
export async function listLiveShas(exceptRunId?: string): Promise<string[]> {
  const result = await getSystemDb().execute<{ sha: string }>(
    liveShasQuery(exceptRunId),
  )
  return result.rows.map((row) => row.sha)
}

/**
 * The checkouts (alias `c`, with its repository `r`) that no reader needs.
 * Only `rev:<sha>` and Workspace keys (`ws:<id>:<sha>` and `ws:<id>`) are
 * candidates; `default` and other shapes stay. Workspace code reads use the
 * published checkout, so no reader uses a Workspace key. A candidate stays
 * when:
 * - it is the published revision of its repository (`rev:<last_ingested_hash>`),
 * - its SHA is in `liveShas` (a running ingestion or index job),
 * - its row changed in the last hour, unless `windowed` is false. A run
 *   touches the row when it starts to use the key, so a run that has only
 *   just started keeps its key. A run that ended gives `windowed: false`
 *   for its own key.
 */
function collectable(liveShas: SQL, windowed = true): SQL {
  return sql`
    c.checkout_key ~ ${`^(rev:${SHA}|ws:[A-Za-z0-9_-]+(:${SHA})?)$`}
    ${windowed ? sql`and greatest(c.created_at, c.updated_at) < now() - interval '1 hour'` : sql``}
    and c.checkout_key <> ('rev:' || coalesce(r.last_ingested_hash, ''))
    and not (regexp_replace(c.checkout_key, '^.*:', '') = any(${liveShas}))
  `
}

const textArray = (values: string[]) =>
  sql`string_to_array(${values.join(",")}, ',')`

/** Every repository of an org. Never throws; a failure gives none. */
async function listOrgRepositories(orgId: string): Promise<string[]> {
  try {
    const result = await withOrgDbContext(orgId, (db) =>
      db.execute<{ id: string }>(sql`select id from repositories order by id`),
    )
    return result.rows.map((row) => row.id)
  } catch (error) {
    log.error({
      step: "codesearch-checkout-gc.org",
      message: `Listing repositories failed: ${formatUnknownError(error)}`,
      orgId,
    })
    return []
  }
}

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
  run?: { endedRunId: string },
): Promise<string[]> {
  const result = await withOrgDbContext(orgId, (db) =>
    db.execute<{ checkout_key: string }>(sql`
      delete from repository_checkouts c
      using repositories r
      where r.id = c.repository_id
        and c.repository_id = ${repositoryId}
        and c.checkout_key = any(${textArray(checkoutKeys)})
        and ${collectable(sql`array(${liveShasQuery(run?.endedRunId)})`, !run)}
      returning c.checkout_key
    `),
  )
  return result.rows.map((row) => row.checkout_key)
}

const deleteResponseSchema = z.object({
  deleted: z.array(z.object({ checkoutKey: z.string() })),
  skipped: z.array(z.object({ checkoutKey: z.string(), reason: z.string() })),
})

/** POST a collection call for one repository, with a `repo-gc` token. */
async function postCollection(
  orgId: string,
  repositoryId: string,
  action: "delete" | "sweep",
  body?: unknown,
): Promise<Response> {
  assertNotInOrgDbContext()
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const token = await signUpstreamJwt({
    env,
    audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
    claims: { sub: `repo-gc:${repositoryId}`, orgId, principal: "service" },
  })
  return fetch(`${codesearchBaseUrl()}/${repositoryId}/checkouts/${action}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function deleteOnCodesearch(
  orgId: string,
  repositoryId: string,
  checkoutKeys: string[],
  runEndedAt?: string,
): Promise<z.infer<typeof deleteResponseSchema> | "busy"> {
  const response = await postCollection(orgId, repositoryId, "delete", {
    checkoutKeys,
    ...(runEndedAt ? { runEndedAt } : {}),
  })
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
 * `maxBatches` caps the codesearch calls of this collection.
 * Never throws; a failure is logged and the next run tries again.
 */
export async function collectRepositoryCheckouts(input: {
  orgId: string
  repositoryId: string
  liveShas?: string[]
  /** Fewer calls than `MAX_BATCHES`; the hourly job finishes the rest. */
  maxBatches?: number
}): Promise<{ deletedKeys: number }> {
  let deletedKeys = 0
  try {
    const liveShas = input.liveShas ?? (await listLiveShas())
    // Codesearch kept these in this pass; do not ask for them again.
    const skipped: string[] = []
    for (
      let batch = 0;
      batch < Math.min(input.maxBatches ?? MAX_BATCHES, MAX_BATCHES);
      batch++
    ) {
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
 * Deletes the `rev:<sha>` checkout of an ingestion run that ended, with or
 * without success, in each repository of the org that has it. It keeps the
 * published revision and a SHA that another unfinished run reads. A run
 * that starts after the list of unfinished runs touches the row after
 * `endedAt`, so its key stays. The hourly collection deletes what this
 * leaves. Never throws.
 */
export async function releaseRunCheckout(input: {
  orgId: string
  sha: string
  runId: string
}): Promise<{ deletedKeys: number }> {
  let deletedKeys = 0
  try {
    const key = repositoryRevisionCheckoutKey(input.sha)
    // The database clock, read before the list: the same clock sets
    // `updated_at` when a run touches the row.
    const [clock] = (
      await getSystemDb().execute<{ ended_at: string }>(
        sql`select to_json(now()) #>> '{}' as ended_at`,
      )
    ).rows
    if (!clock) throw new Error("The database gave no time")
    const endedAt = clock.ended_at
    const liveShas = await listLiveShas(input.runId)
    const candidates = await withOrgDbContext(input.orgId, (db) =>
      db.execute<{ repository_id: string }>(sql`
        select c.repository_id
        from repository_checkouts c
        join repositories r on r.id = c.repository_id
        where c.checkout_key = ${key}
          and c.updated_at <= ${endedAt}::timestamptz
          and ${collectable(textArray(liveShas), false)}
      `),
    )
    for (const { repository_id: repositoryId } of candidates.rows) {
      const result = await deleteOnCodesearch(
        input.orgId,
        repositoryId,
        [key],
        new Date(endedAt).toISOString(),
      )
      // An index job of the repository runs now: the hourly job deletes it.
      if (result === "busy") continue
      const filesDeleted = result.deleted.map((d) => d.checkoutKey)
      const rowsDeleted = filesDeleted.length
        ? await deleteCollectableRows(input.orgId, repositoryId, filesDeleted, {
            endedRunId: input.runId,
          })
        : []
      deletedKeys += rowsDeleted.length
      log.info({
        step: "codesearch-checkout-gc.run-ended",
        message: `Deleted ${rowsDeleted.length} checkouts of an ended run`,
        orgId: input.orgId,
        repositoryId,
        deletedKeys: rowsDeleted.join(","),
      })
    }
  } catch (error) {
    log.error({
      step: "codesearch-checkout-gc.run-ended",
      message: `Deleting the checkout of an ended run failed: ${formatUnknownError(error)}`,
      orgId: input.orgId,
    })
  }
  return { deletedKeys }
}

const sweepResponseSchema = z.object({
  deletedEntries: z.number(),
  deletedBytes: z.number(),
})

/**
 * Asks codesearch to delete the files of one repository that no checkout
 * row names and that are older than one hour (orphan directories, Zoekt
 * shards, and temporary files). Never throws.
 */
async function sweepRepositoryDisk(
  orgId: string,
  repositoryId: string,
): Promise<z.infer<typeof sweepResponseSchema>> {
  const none = { deletedEntries: 0, deletedBytes: 0 }
  try {
    const response = await postCollection(orgId, repositoryId, "sweep")
    if (response.status === 409) {
      await response.body?.cancel()
      return none
    }
    if (!response.ok)
      throw new Error(
        `codesearch checkout sweep failed: ${response.status} ${(await response.text()).slice(0, 300)}`,
      )
    const result = sweepResponseSchema.parse(await response.json())
    if (result.deletedEntries > 0)
      log.info({
        step: "codesearch-checkout-gc.sweep",
        message: `Deleted ${result.deletedEntries} files with no checkout row (${result.deletedBytes} bytes)`,
        orgId,
        repositoryId,
        ...result,
      })
    return result
  } catch (error) {
    log.error({
      step: "codesearch-checkout-gc.sweep",
      message: `Sweeping files with no checkout row failed: ${formatUnknownError(error)}`,
      orgId,
      repositoryId,
    })
    return none
  }
}

/**
 * Collects the old checkouts of every repository of every org. It reads the
 * live SHAs once for the pass.
 */
export async function collectAllCheckouts(): Promise<{
  repositories: number
  deletedKeys: number
  sweptEntries: number
  sweptBytes: number
}> {
  const totals = {
    repositories: 0,
    deletedKeys: 0,
    sweptEntries: 0,
    sweptBytes: 0,
  }
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
    // After the rows: a key whose row the pass deleted has no files left,
    // and the sweep deletes files that no row names.
    for (const repositoryId of await listOrgRepositories(orgId)) {
      const swept = await sweepRepositoryDisk(orgId, repositoryId)
      totals.sweptEntries += swept.deletedEntries
      totals.sweptBytes += swept.deletedBytes
    }
  }
  log.info({
    step: "codesearch-checkout-gc.all",
    message: `Deleted ${totals.deletedKeys} old checkouts in ${totals.repositories} repositories, and ${totals.sweptEntries} files with no checkout row (${totals.sweptBytes} bytes)`,
    ...totals,
  })
  return totals
}
