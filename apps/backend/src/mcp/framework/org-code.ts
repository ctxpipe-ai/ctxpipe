import { and, asc, eq } from "drizzle-orm"

import { withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import {
  CodesearchHttpError,
  type CodesearchHttpOptions,
} from "../../lib/codesearchError.js"
import { publishedRepositoryCheckoutKey } from "../../models/repositories.js"
import { log } from "../../observability/logger.js"
import {
  CodeSearchRejectedError,
  codeSearch,
  zoektLiteralQuery,
} from "../../retrieval/services/codeSearch.js"
import {
  codesearchGraphQuery,
  type GraphRequestBody,
} from "../../tools/codesearchGraph.js"
import {
  codesearchStructuralSearchJson,
  type StructuralSearchBody,
} from "../../tools/structuralSearch.js"
import { type CallWorkspace, listOrgRepositoryUrls } from "./call-workspace.js"
import { RepositoryHandles } from "./repository-handles.js"
import { McpToolError } from "./tool-errors.js"
import type { CallOrg } from "./tool-org.js"

/**
 * SCIP and structural search query at most this many repositories in one call
 * (ADR-051 §7, ADR-027). The rest of the scope is `skipped` as `over_limit`.
 */
export const SCIP_FAN_OUT_LIMIT = 10

/**
 * SCIP and structural requests in flight for each backend process. Codesearch
 * has no admission limit for SCIP loads (only an index cache), so this limit
 * protects it when several calls run at once.
 */
export const SCIP_PROCESS_LIMIT = 20

/** Default time for all codesearch requests of one call, retries included. */
const CALL_DEADLINE_MS = 20_000

/** A short retry budget: an MCP call must not wait minutes on an outage. */
const MCP_RETRY = { retries: 3, baseDelayMs: 200, maxDelayMs: 2_000 }

/** A linked repository that codesearch can search, and the revision it serves. */
export type CodeRepository = {
  handle: string
  repositoryId: string
  zoektRepoId: number
  branch: string
  sha: string
}

export type SkippedRepository = {
  repository: string
  reason: "not_indexed" | "failed" | "over_limit"
}

/**
 * The repositories of one code search call. `excluded` lists the handles in
 * scope that `excludeRepositories` removed; codesearch never receives them.
 */
type CodeScope = {
  repositories: CodeRepository[]
  excluded: string[]
  skipped: SkippedRepository[]
}

export type CodeResults<T> = {
  results: T[]
  excluded: string[]
  skipped: SkippedRepository[]
  truncated: boolean
  /** Offset of the next page in the merged results, or null at the end. */
  nextOffset: number | null
  /** How to narrow the call when repositories are `over_limit`. */
  hint?: string
}

type Budget = {
  limit: number
  /** Results to skip: the offset of a cursor. */
  offset?: number
  /** Time for all codesearch requests of the call. Default 20 s. */
  deadlineMs?: number
}

function transportFor(budget: Budget): Required<CodesearchHttpOptions> {
  return {
    signal: AbortSignal.timeout(budget.deadlineMs ?? CALL_DEADLINE_MS),
    retry: MCP_RETRY,
  }
}

/**
 * Org + optional Workspace + repository handles → the repositories to search
 * (ADR-051 §4, §7). Repositories resolve at org level, so a repository that
 * several Workspaces link occurs once. Exclusion runs before any request. A
 * linked repository with no published checkout, or with a checkout that has
 * no commit SHA, is `not_indexed`.
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
        branch: repositoryCheckouts.ref,
        sha: repositoryCheckouts.commitSha,
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
    if (indexed.has(handle) || !row.sha) continue
    indexed.set(handle, {
      handle,
      repositoryId: row.id,
      zoektRepoId: row.zoektRepoId,
      branch: row.branch,
      sha: row.sha,
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
 * A path glob as an anchored RE2 expression for the Zoekt `file:` atom. `*`
 * and `?` stay in one path segment, `**` crosses segments, and `{a,b}` is an
 * alternative.
 */
export function pathGlobRegex(glob: string): string {
  let out = ""
  let depth = 0
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1
        if (glob[index + 1] === "/") {
          index += 1
          out += "(?:.*/)?"
        } else out += ".*"
      } else out += "[^/]*"
    } else if (char === "?") out += "[^/]"
    else if (char === "{") {
      depth += 1
      out += "(?:"
    } else if (char === "}" && depth > 0) {
      depth -= 1
      out += ")"
    } else if (char === "," && depth > 0) out += "|"
    else out += char.replace(/[\\^$.|+()[\]{}]/g, "\\$&")
  }
  if (depth > 0) {
    throw new McpToolError("invalid_argument", "pathGlob has an open brace.")
  }
  return `^${out}$`
}

/**
 * Check a `pathGlob` of `search_code`. It is a gitignore-style glob: a glob
 * with no `/` matches at any depth, and a glob with a `/` starts at the
 * repository root. A `!` negation is not allowed in any mode.
 */
export function checkPathGlob(glob: string): string {
  if (glob.startsWith("!")) {
    throw new McpToolError(
      "invalid_argument",
      "pathGlob does not allow a ! negation. Search the paths that you want.",
    )
  }
  return glob
}

/**
 * A regex query goes inside `(...)`, so that `file:` and `case:` apply to
 * the whole query. A query with an unbalanced parenthesis, or a trailing
 * backslash, could close the group early or escape it, so it is rejected.
 */
function checkRegex(query: string): string {
  let open = 0
  let escaped = false
  let inClass = false
  for (const char of query) {
    if (escaped) escaped = false
    else if (char === "\\") escaped = true
    else if (inClass) inClass = char !== "]"
    else if (char === "[") inClass = true
    else if (char === "(") open += 1
    else if (char === ")") {
      open -= 1
      if (open < 0) break
    }
  }
  if (open !== 0 || escaped || inClass) {
    throw new McpToolError(
      "invalid_argument",
      "query: the regex has an unbalanced ( ), [ ], or a trailing backslash.",
    )
  }
  return query
}

/** One file of a Zoekt answer, with its matching lines. */
type CodeFileMatches = {
  repository: string
  path: string
  language: string | null
  matches: Array<{ line: number | null; snippet: string }>
}

/**
 * Zoekt search over the scope in one request. Files keep the Zoekt order,
 * and `limit` counts files. `literal` quotes the text; `regex` sends it as a
 * Zoekt query (RE2). `pathGlob` adds a `file:` atom and `caseSensitive` a
 * `case:` atom. A rejected query is `invalid_argument`, with no literal
 * retry. A failed request is a retryable `internal` error: Zoekt answers for
 * all repositories at once, so no single repository is at fault.
 */
export async function searchCodeText(
  org: CallOrg,
  scope: CodeScope,
  input: {
    query: string
    mode: "literal" | "regex"
    pathGlob?: string
    caseSensitive?: boolean
  } & Budget,
): Promise<CodeResults<CodeFileMatches>> {
  const byZoektId = new Map(
    scope.repositories.map((repository) => [
      repository.zoektRepoId,
      repository.handle,
    ]),
  )
  const atoms = [
    ...(input.pathGlob
      ? [
          `file:${zoektLiteralQuery(
            pathGlobRegex(
              checkPathGlob(input.pathGlob).includes("/")
                ? input.pathGlob
                : `**/${input.pathGlob}`,
            ),
          )}`,
        ]
      : []),
    ...(input.caseSensitive === undefined
      ? []
      : [input.caseSensitive ? "case:yes" : "case:no"]),
  ]
  const text =
    input.mode === "literal"
      ? zoektLiteralQuery(input.query)
      : atoms.length > 0
        ? `(${checkRegex(input.query)})`
        : input.query
  let found: Awaited<ReturnType<typeof codeSearch>> = []
  if (scope.repositories.length > 0) {
    try {
      found = await codeSearch(org.id, {
        query: [text, ...atoms].join(" "),
        repositories: scope.repositories.map((repository) => ({
          id: repository.repositoryId,
          name: repository.handle,
          zoektRepoId: repository.zoektRepoId,
        })),
        strict: true,
        transport: transportFor(input),
      })
    } catch (error) {
      if (error instanceof CodeSearchRejectedError) {
        throw new McpToolError("invalid_argument", `query: ${error.message}`)
      }
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
          Language?: string
          LineMatches?: Array<{ LineNumber?: number; Line?: string }>
        }>
      | undefined) ?? []
  const matches = files.flatMap((file): CodeFileMatches[] => {
    const repository =
      file.RepositoryID === undefined
        ? undefined
        : byZoektId.get(file.RepositoryID)
    if (!repository || !file.FileName) return []
    return [
      {
        repository,
        path: file.FileName,
        language: file.Language || null,
        matches: (file.LineMatches ?? []).map((match) => ({
          line: typeof match.LineNumber === "number" ? match.LineNumber : null,
          snippet: Buffer.from(match.Line ?? "", "base64").toString("utf-8"),
        })),
      },
    ]
  })
  return capped(matches, scope, scope.skipped, input)
}

/** The anchors that each graph primitive needs (the codesearch `/graph` rules). */
function checkGraphAnchors(
  body: Omit<GraphRequestBody, "checkoutKey" | "limit">,
) {
  const needs =
    body.primitive === "trace_path" || body.primitive === "get_containing_scope"
      ? body.symbol && body.filePath
        ? null
        : "symbol and filePath"
      : body.primitive === "find_symbol" || body.primitive === "get_imports"
        ? body.symbol || body.filePath || body.module
          ? null
          : "symbol, filePath, or module"
        : body.symbol
          ? null
          : "symbol"
  if (needs) {
    throw new McpToolError(
      "invalid_argument",
      `${body.primitive} needs ${needs}.`,
    )
  }
}

/**
 * One SCIP graph primitive over each repository of the scope. `keep` filters
 * the rows of each repository before the merge, so a cursor counts only the
 * kept rows. With `keep`, each repository gives its full 200 rows, because
 * the filter can drop any of them.
 */
export async function findSymbolAcrossRepositories(
  org: CallOrg,
  scope: CodeScope,
  body: Omit<GraphRequestBody, "checkoutKey" | "limit">,
  budget: Budget,
  keep?: (row: Record<string, unknown>) => boolean,
): Promise<CodeResults<Record<string, unknown> & { repository: string }>> {
  checkGraphAnchors(body)
  return fanOut(scope, budget, "graph", async (repository, transport) => {
    const answer = await codesearchGraphQuery(
      { id: repository.repositoryId, orgId: org.id },
      { ...body, limit: keep ? 200 : repositoryLimit(budget, 200) },
      undefined,
      transport,
    )
    // An empty answer without an index is not "no symbol".
    if (answer.index === "missing") return "not_indexed"
    if (answer.index === "unreadable") return "failed"
    const rows = Array.isArray(answer.results)
      ? (answer.results as Record<string, unknown>[])
      : []
    return keep ? rows.filter(keep) : rows
  })
}

/** One ast-grep pattern over each repository of the scope. */
export async function structuralSearchAcrossRepositories(
  org: CallOrg,
  scope: CodeScope,
  body: Omit<StructuralSearchBody, "limit">,
  budget: Budget,
): Promise<CodeResults<Record<string, unknown> & { repository: string }>> {
  return fanOut(scope, budget, "structural", async (repository, transport) => {
    const answer = await codesearchStructuralSearchJson(
      { id: repository.repositoryId, orgId: org.id },
      { ...body, limit: repositoryLimit(budget, 1_000) },
      undefined,
      transport,
    )
    if (!answer.ok) {
      throw new CodesearchHttpError(
        `structural search failed with status ${answer.status}`,
        answer.status,
        answer.detail,
      )
    }
    const matches = (answer.json as { matches?: unknown }).matches
    return Array.isArray(matches) ? (matches as Record<string, unknown>[]) : []
  })
}

/** Counting semaphore. A waiter leaves the queue when its signal aborts. */
class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly size: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.active < this.size) {
      this.active += 1
      return this.releaser()
    }
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      }
      const onAbort = () => {
        const at = this.waiters.indexOf(wake)
        if (at >= 0) this.waiters.splice(at, 1)
        reject(signal.reason)
      }
      this.waiters.push(wake)
      signal.addEventListener("abort", onAbort, { once: true })
    })
    // The slot passes from the releaser to this waiter.
    return this.releaser()
  }

  private releaser(): () => void {
    let done = false
    return () => {
      if (done) return
      done = true
      const next = this.waiters.shift()
      if (next) next()
      else this.active -= 1
    }
  }
}

const scipRequests = new Semaphore(SCIP_PROCESS_LIMIT)

type RepositoryAnswer =
  | { items: Record<string, unknown>[] }
  | { skip: SkippedRepository["reason"] }
  | { invalid: string }

/**
 * Runs `search` in parallel for the first {@link SCIP_FAN_OUT_LIMIT}
 * repositories in handle order, within the process limit and the deadline
 * of the call. The rest are `skipped` as `over_limit`. A failing repository
 * is `skipped`; the call continues. A 400 from codesearch is a caller error
 * and gives `invalid_argument`. The merge takes rank 0 of each repository in
 * handle order, then rank 1, and so on, so the order does not depend on
 * which answer arrives first, and the cap does not fill with one repository.
 */
async function fanOut(
  scope: CodeScope,
  budget: Budget,
  kind: "graph" | "structural",
  search: (
    repository: CodeRepository,
    transport: CodesearchHttpOptions,
  ) => Promise<Record<string, unknown>[] | "not_indexed" | "failed">,
): Promise<CodeResults<Record<string, unknown> & { repository: string }>> {
  const searched = scope.repositories.slice(0, SCIP_FAN_OUT_LIMIT)
  const overLimit = scope.repositories.slice(SCIP_FAN_OUT_LIMIT)
  const transport = transportFor(budget)
  const answers = await Promise.all(
    searched.map(async (repository): Promise<RepositoryAnswer> => {
      let release: (() => void) | undefined
      try {
        release = await scipRequests.acquire(transport.signal)
        const answer = await search(repository, transport)
        return typeof answer === "string" ? { skip: answer } : { items: answer }
      } catch (error) {
        if (error instanceof CodesearchHttpError && error.status === 400) {
          return { invalid: error.detail || error.message }
        }
        if (error instanceof CodesearchHttpError && error.status === 404) {
          return { skip: "not_indexed" }
        }
        // The error text can echo the query. Keep it off the wide event.
        log.warn({
          step: `mcp.code_search.${kind}.repository_failed`,
          repositoryId: repository.repositoryId,
        })
        return { skip: "failed" }
      } finally {
        release?.()
      }
    }),
  )
  const invalid = answers.find((answer) => "invalid" in answer)
  if (invalid && "invalid" in invalid) {
    throw new McpToolError("invalid_argument", invalid.invalid)
  }

  const skipped = [...scope.skipped]
  searched.forEach((repository, index) => {
    const answer = answers[index]
    if (answer && "skip" in answer)
      skipped.push({ repository: repository.handle, reason: answer.skip })
  })
  for (const repository of overLimit)
    skipped.push({ repository: repository.handle, reason: "over_limit" })
  const merged: Array<Record<string, unknown> & { repository: string }> = []
  const lists = answers.map((answer) => ("items" in answer ? answer.items : []))
  const longest = Math.max(0, ...lists.map((items) => items.length))
  for (let rank = 0; rank < longest; rank += 1) {
    searched.forEach((repository, index) => {
      const item = lists[index]?.[rank]
      if (item) merged.push({ ...item, repository: repository.handle })
    })
  }
  const results = capped(merged, scope, skipped, budget)
  if (overLimit.length === 0) return results
  return {
    ...results,
    hint: `Searched ${SCIP_FAN_OUT_LIMIT} of ${scope.repositories.length} repositories. Name the repositories to search in \`repositories\`, or narrow the call to one \`workspace\`.`,
  }
}

/**
 * Results each repository gives for one page: the offset, the page, and one
 * more to show that the page is not the last. Codesearch caps the answer, so
 * a cursor cannot go past `ceiling` results of one repository.
 */
function repositoryLimit(budget: Budget, ceiling: number): number {
  return Math.min(ceiling, (budget.offset ?? 0) + budget.limit + 1)
}

function capped<T>(
  items: T[],
  scope: CodeScope,
  skipped: SkippedRepository[],
  budget: Budget,
): CodeResults<T> {
  const start = budget.offset ?? 0
  const page = items.slice(start, start + budget.limit)
  const nextOffset =
    start + page.length < items.length ? start + page.length : null
  return {
    results: page,
    excluded: scope.excluded,
    skipped,
    truncated: nextOffset !== null,
    nextOffset,
  }
}

/**
 * One linked repository, ready to read from its published checkout. Exclusion
 * is checked before any codesearch request. With a Workspace, the repository
 * must be one that this Workspace links; without one, any repository that a
 * Workspace of the org links.
 */
export async function requireLinkedRepository(
  org: CallOrg,
  workspace: CallWorkspace | undefined,
  repository: string,
  excludeRepositories: readonly string[],
): Promise<CodeRepository> {
  const scope = await resolveCodeScope(org, {
    workspaceId: workspace?.id,
    repositories: [repository],
    excludeRepositories,
  })
  const [excluded] = scope.excluded
  if (excluded) {
    throw new McpToolError(
      "excluded_repository",
      `The call excludes "${excluded}". Read that repository from the local checkout.`,
    )
  }
  const [linked] = scope.repositories
  if (linked) return linked
  throw new McpToolError(
    "workspace_not_ready",
    `Repository "${scope.skipped[0]?.repository ?? repository}" has no index yet. Try again in a few minutes.`,
  )
}
