import { signUpstreamJwt } from "../../auth/upstreamJwt.js"
import { parseEnv } from "../../config/env.js"
import { assertNotInOrgDbContext } from "../../db/client.js"
import { codesearchBaseUrl } from "../../lib/agentToolRuntime.js"
import { readCodesearchError } from "../../lib/codesearchError.js"
import { withTransientHttpRetry } from "../../lib/withTransientHttpRetry.js"
import { RepositoryGoneError } from "./repositoryGone.js"
import { capturedSourceRevision } from "./source-revision-context.js"

export type FileEntry = { name: string; path: string; type: "file" | "dir" }

type GlobFilesRequest = {
  pattern: string
  path?: string
  onlyFiles?: boolean
  dot?: boolean
  limit?: number
}

export type GlobFilesResponse = {
  entries: FileEntry[]
  truncated: boolean
  matched: number
}

export class CodesearchCheckoutError extends Error {
  override readonly name = "CodesearchCheckoutError"

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

type CodesearchAuthExtras = {
  sha?: string
  workspaceId?: string
  retries?: number
}

async function fetchWithAuth(
  url: string,
  options: RequestInit,
  repositoryId: string,
  orgId: string,
  extras?: CodesearchAuthExtras,
): Promise<Response> {
  assertNotInOrgDbContext()
  const source = capturedSourceRevision(orgId, repositoryId)
  if (
    source &&
    (extras?.workspaceId || (extras?.sha && extras.sha !== source.sha))
  )
    throw new Error("Extraction read differs from its captured source revision")
  const sourceSha = extras?.workspaceId
    ? undefined
    : (extras?.sha ?? source?.sha)
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const token = await signUpstreamJwt({
    env,
    audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
    claims: {
      sub: `repo:${repositoryId}`,
      orgId,
      principal: "service",
      ...(sourceSha
        ? { repositoryRevisions: [{ repositoryId, sha: sourceSha }] }
        : {}),
      ...(extras?.workspaceId ? { workspaceId: extras.workspaceId } : {}),
      ...(extras?.sha && extras.workspaceId
        ? { workspaceRevisions: [{ repositoryId, sha: extras.sha }] }
        : {}),
    },
  })
  const retries = extras?.retries ?? 10
  return withTransientHttpRetry(
    async () =>
      fetch(url, {
        ...options,
        ...(retries === 0 ? { signal: AbortSignal.timeout(5_000) } : {}),
        headers: {
          ...options.headers,
          Authorization: `Bearer ${token}`,
        },
      }),
    {
      retries,
      baseDelayMs: 200,
      maxDelayMs: retries === 0 ? 0 : 30_000,
    },
  )
}

async function raiseCodesearchFailure(
  operation: string,
  res: Response,
  kind: "error" | "checkout" = "error",
): Promise<never> {
  const failure = await readCodesearchError(res)
  if (failure.code === "repository_not_found") {
    throw new RepositoryGoneError(failure.message || undefined)
  }
  const message = `${operation} failed: ${failure.status}${failure.message ? `: ${failure.message}` : ""}`
  if (kind === "checkout") {
    throw new CodesearchCheckoutError(message, res.status)
  }
  throw new Error(message)
}

/**
 * Glob files/directories in a repository checkout via codesearch Bun.Glob.
 * Defaults match codesearch: onlyFiles=false, dot=true.
 */
export async function globFiles(
  repositoryId: string,
  orgId: string,
  request: GlobFilesRequest,
  extras?: CodesearchAuthExtras,
): Promise<GlobFilesResponse> {
  const res = await fetchWithAuth(
    `${codesearchBaseUrl()}/${repositoryId}/glob`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pattern: request.pattern,
        path: request.path ?? "",
        onlyFiles: request.onlyFiles,
        dot: request.dot,
        limit: request.limit,
      }),
    },
    repositoryId,
    orgId,
    extras,
  )
  if (!res.ok) {
    await raiseCodesearchFailure("globFiles", res, "checkout")
  }
  return (await res.json()) as GlobFilesResponse
}

/** Fail-fast glob of the codesearch checkout. Pass workspaceId for a Workspace read of the published checkout. */
export async function globCheckoutFiles(input: {
  repositoryId: string
  orgId: string
  workspaceId?: string
  sha?: string
  request?: GlobFilesRequest
}): Promise<GlobFilesResponse> {
  return globFiles(
    input.repositoryId,
    input.orgId,
    input.request ?? { pattern: "**/*", onlyFiles: true, dot: true },
    {
      workspaceId: input.workspaceId,
      sha: input.sha,
      retries: 0,
    },
  )
}

/** Fail-fast file-path listing of the codesearch checkout. No glob, no Postgres. */
export async function listCheckoutTree(input: {
  repositoryId: string
  orgId: string
  workspaceId?: string
  sha?: string
}): Promise<string[]> {
  const res = await fetchWithAuth(
    `${codesearchBaseUrl()}/${input.repositoryId}/tree`,
    { method: "GET" },
    input.repositoryId,
    input.orgId,
    {
      workspaceId: input.workspaceId,
      sha: input.sha,
      retries: 0,
    },
  )
  if (!res.ok) {
    await raiseCodesearchFailure("listCheckoutTree", res, "checkout")
  }
  const data = (await res.json()) as { paths: string[] }
  return data.paths
}

/**
 * Fetches file contents by path. Returns map of path -> utf-8 content.
 */
export async function fetchFiles(
  repositoryId: string,
  orgId: string,
  paths: string[],
  extras?: CodesearchAuthExtras,
): Promise<Record<string, string>> {
  if (paths.length === 0) return {}
  const res = await fetchWithAuth(
    `${codesearchBaseUrl()}/${repositoryId}/files-query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    },
    repositoryId,
    orgId,
    extras,
  )
  if (!res.ok) {
    await raiseCodesearchFailure("fetchFiles", res, "checkout")
  }
  const encoded = (await res.json()) as Record<string, string>
  const result: Record<string, string> = {}
  for (const [p, b64] of Object.entries(encoded)) {
    result[p] = Buffer.from(b64, "base64").toString("utf-8")
  }
  return result
}

/** Fail-fast file bytes from the codesearch checkout. Pass workspaceId for a Workspace read of the published checkout. */
type CheckoutFileQuery = {
  repositoryId: string
  orgId: string
  workspaceId?: string
  sha?: string
  path: string
  /**
   * A folder of the checkout: `path` is relative to it, and codesearch never
   * reads outside it, also through a symlink.
   */
  root?: string
}

export async function fetchCheckoutFileBytes(
  input: CheckoutFileQuery,
): Promise<Uint8Array | null> {
  const file = await queryCheckoutFile(input)
  // Without `maxBytes`, codesearch always sends the bytes.
  return typeof file === "string" ? Buffer.from(file, "base64") : null
}

/**
 * Reads a checkout file only when it has at most `maxBytes` bytes.
 * Codesearch does not read a larger file: the result has only its size.
 */
export async function fetchCheckoutFileBytesUpTo(
  input: CheckoutFileQuery & { maxBytes: number },
): Promise<Uint8Array | { tooLarge: true; size: number } | null> {
  const file = await queryCheckoutFile(input)
  if (file === undefined) return null
  if (typeof file !== "string") return { tooLarge: true, size: file.size }
  const bytes = Buffer.from(file, "base64")
  // A codesearch from before `maxBytes` sends every file in full.
  return bytes.length > input.maxBytes
    ? { tooLarge: true, size: bytes.length }
    : bytes
}

async function queryCheckoutFile(
  input: CheckoutFileQuery & { maxBytes?: number },
): Promise<string | { size: number } | undefined> {
  const res = await fetchWithAuth(
    `${codesearchBaseUrl()}/${input.repositoryId}/files-query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: [input.path],
        ...(input.root ? { root: input.root } : {}),
        ...(input.maxBytes ? { maxBytes: input.maxBytes } : {}),
      }),
    },
    input.repositoryId,
    input.orgId,
    {
      workspaceId: input.workspaceId,
      sha: input.sha,
      retries: 0,
    },
  )
  if (!res.ok) {
    await raiseCodesearchFailure("fetchCheckoutFileBytes", res, "checkout")
  }
  const files = (await res.json()) as Record<string, string | { size: number }>
  return files[input.path]
}
