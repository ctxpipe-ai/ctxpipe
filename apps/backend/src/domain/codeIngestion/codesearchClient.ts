import { signUpstreamJwt } from "../../auth/upstreamJwt.js"
import { parseEnv } from "../../config/env.js"
import { codesearchBaseUrl } from "../../lib/agentToolRuntime.js"
import { readCodesearchError } from "../../lib/codesearchError.js"
import { withTransientHttpRetry } from "../../lib/withTransientHttpRetry.js"
import { RepositoryGoneError } from "./repositoryGone.js"

export type FileEntry = { name: string; path: string; type: "file" | "dir" }

export type GlobFilesRequest = {
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

async function fetchWithAuth(
  url: string,
  options: RequestInit,
  repositoryId: string,
  orgId: string,
): Promise<Response> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const token = await signUpstreamJwt({
    env,
    audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
    claims: {
      sub: `repo:${repositoryId}`,
      orgId,
      principal: "service",
    },
  })
  return withTransientHttpRetry(
    async () =>
      fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          Authorization: `Bearer ${token}`,
        },
      }),
    { retries: 10, baseDelayMs: 200, maxDelayMs: 30_000 },
  )
}

async function raiseCodesearchFailure(
  operation: string,
  res: Response,
): Promise<never> {
  const failure = await readCodesearchError(res)
  if (failure.code === "repository_not_found") {
    throw new RepositoryGoneError(failure.message || undefined)
  }
  throw new Error(
    `${operation} failed: ${failure.status}${failure.message ? `: ${failure.message}` : ""}`,
  )
}

/**
 * Lists files and directories at a path. Returns entries with name, path, type.
 */
export async function listFiles(
  repositoryId: string,
  orgId: string,
  path = "",
): Promise<FileEntry[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ""
  const res = await fetchWithAuth(
    `${codesearchBaseUrl()}/${repositoryId}/files${query}`,
    { method: "GET" },
    repositoryId,
    orgId,
  )
  if (!res.ok) {
    await raiseCodesearchFailure("listFiles", res)
  }
  const data = (await res.json()) as { entries: FileEntry[] }
  return data.entries
}

/**
 * Glob files/directories in a repository checkout via codesearch Bun.Glob.
 * Defaults match codesearch: onlyFiles=false, dot=true.
 */
export async function globFiles(
  repositoryId: string,
  orgId: string,
  request: GlobFilesRequest,
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
  )
  if (!res.ok) {
    await raiseCodesearchFailure("globFiles", res)
  }
  return (await res.json()) as GlobFilesResponse
}

/**
 * Fetches file contents by path. Returns map of path -> utf-8 content.
 */
export async function fetchFiles(
  repositoryId: string,
  orgId: string,
  paths: string[],
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
  )
  if (!res.ok) {
    await raiseCodesearchFailure("fetchFiles", res)
  }
  const encoded = (await res.json()) as Record<string, string>
  const result: Record<string, string> = {}
  for (const [p, b64] of Object.entries(encoded)) {
    result[p] = Buffer.from(b64, "base64").toString("utf-8")
  }
  return result
}
