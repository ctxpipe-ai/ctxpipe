import { and, asc, eq } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import { publishedRepositoryCheckoutKey } from "../../models/repositories.js"
import { log } from "../../observability/logger.js"
import { codeSearch } from "../../retrieval/services/codeSearch.js"
import {
  codesearchGraphQuery,
  type GraphRequestBody,
} from "../../tools/codesearchGraph.js"
import {
  codesearchStructuralSearchJson,
  type StructuralSearchBody,
} from "../../tools/structuralSearch.js"
import { pageWithinBudget } from "./budget.js"
import { listOrgRepositoryUrls } from "./call-workspace.js"
import { RepositoryHandles } from "./repository-handles.js"
import { McpToolError } from "./tool-errors.js"
import type { CallOrg } from "./tool-org.js"

/** SCIP and structural search send at most this many requests at once (ADR-051 §7, ADR-027). */
export const SCIP_FAN_OUT_LIMIT = 10

/** A linked repository that codesearch can search. */
export type CodeRepository = {
  handle: string
  repositoryId: string
  zoektRepoId: number
  checkoutKey: string
}

export type SkippedRepository = {
  repository: string
  reason: "not_indexed" | "failed"
}

/**
 * The repositories of one code search call. `excluded` lists the handles in
 * scope that `excludeRepositories` removed; codesearch never receives them.
 */
export type CodeScope = {
  repositories: CodeRepository[]
  excluded: string[]
  skipped: SkippedRepository[]
}

export type CodeResults<T> = {
  results: T[]
  excluded: string[]
  skipped: SkippedRepository[]
  truncated: boolean
}

type Budget = { limit: number; maxTokens: number }

/**
 * Org + optional Workspace + repository handles → the repositories to search
 * (ADR-051 §4, §7). Repositories resolve at org level, so a repository that
 * several Workspaces link occurs once. Exclusion runs before any request. A
 * linked repository with no published checkout is `not_indexed`.
 */
export async function resolveCodeScope(
  org: CallOrg,
  input: {
    workspaceId?: string
    repositories?: readonly string[]
    excludeRepositories: readonly string[]
  },
): Promise<CodeScope> {
  const handles = RepositoryHandles.from(await listOrgRepositoryUrls(org))
  const exclusion = handles.exclusion(input.excludeRepositories)
  const inWorkspace = input.workspaceId
    ? new Set(
        RepositoryHandles.from(
          await listOrgRepositoryUrls(org, input.workspaceId),
        )
          .list()
          .map((repository) => handles.resolve(repository.url).handle),
      )
    : null
  const wanted = input.repositories?.length
    ? input.repositories.map((name) => {
        const { handle } = handles.resolve(name)
        if (inWorkspace && !inWorkspace.has(handle)) {
          throw new McpToolError(
            "repository_not_found",
            `The Workspace does not link "${name}". Call list_workspaces with the workspace to see its repositories.`,
          )
        }
        return handle
      })
    : handles
        .list()
        .map((repository) => repository.handle)
        .filter((handle) => !inWorkspace || inWorkspace.has(handle))
  const excludedHandles = new Set(exclusion.excluded)
  const inScope = [...new Set(wanted)].sort()

  const rows = await withOrgDbContext(org.id, (db) =>
    db
      .select({
        id: repositories.id,
        gitUrl: repositories.gitUrl,
        zoektRepoId: repositoryCheckouts.zoektRepoId,
        checkoutKey: repositoryCheckouts.checkoutKey,
      })
      .from(repositories)
      .innerJoin(
        repositoryCheckouts,
        and(
          eq(repositoryCheckouts.repositoryId, repositories.id),
          eq(repositoryCheckouts.checkoutKey, publishedRepositoryCheckoutKey()),
        ),
      )
      .where(eq(repositories.orgId, org.id))
      .orderBy(asc(repositories.createdAt), asc(repositories.id)),
  )
  const indexed = new Map<string, CodeRepository>()
  for (const row of rows) {
    let handle: string
    try {
      handle = handles.resolve(row.gitUrl).handle
    } catch {
      continue // Ingested, but no Workspace of the org links it.
    }
    if (indexed.has(handle)) continue
    indexed.set(handle, {
      handle,
      repositoryId: row.id,
      zoektRepoId: row.zoektRepoId,
      checkoutKey: row.checkoutKey,
    })
  }

  const scope: CodeScope = { repositories: [], excluded: [], skipped: [] }
  for (const handle of inScope) {
    const repository = indexed.get(handle)
    if (excludedHandles.has(handle)) scope.excluded.push(handle)
    else if (repository) scope.repositories.push(repository)
    else scope.skipped.push({ repository: handle, reason: "not_indexed" })
  }
  return scope
}

/**
 * Zoekt search over the scope in one request. Matches keep the Zoekt order.
 * A failed request is a retryable `internal` error: Zoekt answers for all
 * repositories at once, so no single repository is at fault.
 */
export async function searchCodeText(
  org: CallOrg,
  scope: CodeScope,
  input: { query: string } & Budget,
): Promise<
  CodeResults<{
    repository: string
    path: string
    line: number | null
    snippet: string
  }>
> {
  const byZoektId = new Map(
    scope.repositories.map((repository) => [
      repository.zoektRepoId,
      repository.handle,
    ]),
  )
  let found: Awaited<ReturnType<typeof codeSearch>> = []
  if (scope.repositories.length > 0) {
    try {
      found = await codeSearch(org.id, {
        query: input.query,
        repositoryIds: scope.repositories.map(
          (repository) => repository.repositoryId,
        ),
      })
    } catch {
      log.warn({ step: "mcp.code_search.failed", orgId: org.id })
      throw new McpToolError(
        "internal",
        "Code search is not available at the moment. Try again.",
      )
    }
  }
  const files =
    ((found[0]?.response as { Files?: unknown } | undefined)?.Files as
      | Array<{
          FileName?: string
          RepositoryID?: number
          LineMatches?: Array<{ LineNumber?: number; Line?: string }>
        }>
      | undefined) ?? []
  const matches = files.flatMap((file) => {
    const repository =
      file.RepositoryID === undefined
        ? undefined
        : byZoektId.get(file.RepositoryID)
    if (!repository || !file.FileName) return []
    return (file.LineMatches ?? []).map((match) => ({
      repository,
      path: file.FileName as string,
      line: typeof match.LineNumber === "number" ? match.LineNumber : null,
      snippet: Buffer.from(match.Line ?? "", "base64").toString("utf-8"),
    }))
  })
  return capped(matches, scope, scope.skipped, input)
}

/** One SCIP graph primitive over each repository of the scope. */
export function findSymbolAcrossRepositories(
  org: CallOrg,
  scope: CodeScope,
  body: Omit<GraphRequestBody, "checkoutKey" | "limit">,
  budget: Budget,
): Promise<CodeResults<Record<string, unknown> & { repository: string }>> {
  return fanOut(scope, budget, "graph", async (repository) => {
    const answer = await codesearchGraphQuery(
      { id: repository.repositoryId, orgId: org.id },
      { ...body, limit: budget.limit },
    )
    return Array.isArray(answer.results)
      ? (answer.results as Record<string, unknown>[])
      : []
  })
}

/** One ast-grep pattern over each repository of the scope. */
export function structuralSearchAcrossRepositories(
  org: CallOrg,
  scope: CodeScope,
  body: Omit<StructuralSearchBody, "limit">,
  budget: Budget,
): Promise<CodeResults<Record<string, unknown> & { repository: string }>> {
  return fanOut(scope, budget, "structural", async (repository) => {
    const answer = await codesearchStructuralSearchJson(
      { id: repository.repositoryId, orgId: org.id },
      { ...body, limit: budget.limit },
    )
    if (!answer.ok) throw new Error(`status ${answer.status}`)
    const matches = (answer.json as { matches?: unknown }).matches
    return Array.isArray(matches) ? (matches as Record<string, unknown>[]) : []
  })
}

/**
 * Runs `search` for each repository, at most {@link SCIP_FAN_OUT_LIMIT} at
 * once. A repository whose request fails is `skipped`; the call continues.
 * The merge takes rank 0 of each repository in handle order, then rank 1,
 * and so on, so the order does not depend on which answer arrives first,
 * and the cap does not fill with one repository.
 */
async function fanOut(
  scope: CodeScope,
  budget: Budget,
  kind: "graph" | "structural",
  search: (repository: CodeRepository) => Promise<Record<string, unknown>[]>,
): Promise<CodeResults<Record<string, unknown> & { repository: string }>> {
  const answers: Array<Record<string, unknown>[] | null> = new Array(
    scope.repositories.length,
  ).fill(null)
  let next = 0
  const worker = async () => {
    while (next < scope.repositories.length) {
      const index = next++
      const repository = scope.repositories[index] as CodeRepository
      try {
        answers[index] = await search(repository)
      } catch {
        // The error text can echo the query. Keep it off the wide event.
        log.warn({
          step: `mcp.code_search.${kind}.repository_failed`,
          repositoryId: repository.repositoryId,
        })
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(SCIP_FAN_OUT_LIMIT, scope.repositories.length) },
      worker,
    ),
  )

  const skipped = [...scope.skipped]
  scope.repositories.forEach((repository, index) => {
    if (answers[index] === null)
      skipped.push({ repository: repository.handle, reason: "failed" })
  })
  const merged: Array<Record<string, unknown> & { repository: string }> = []
  const longest = Math.max(0, ...answers.map((answer) => answer?.length ?? 0))
  for (let rank = 0; rank < longest; rank += 1) {
    scope.repositories.forEach((repository, index) => {
      const item = answers[index]?.[rank]
      if (item) merged.push({ ...item, repository: repository.handle })
    })
  }
  return capped(merged, scope, skipped, budget)
}

function capped<T>(
  items: T[],
  scope: CodeScope,
  skipped: SkippedRepository[],
  budget: Budget,
): CodeResults<T> {
  const { page, nextOffset } = pageWithinBudget(items, {
    limit: budget.limit,
    maxTokens: budget.maxTokens,
    measure: (item) => JSON.stringify(item),
  })
  return {
    results: page,
    excluded: scope.excluded,
    skipped,
    truncated: nextOffset !== null,
  }
}
