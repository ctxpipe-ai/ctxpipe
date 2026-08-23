import { signUpstreamJwt } from "../../auth/upstreamJwt.js"
import { parseEnv } from "../../config/env.js"
import { assertNotInOrgDbContext } from "../../db/client.js"
import { codesearchBaseUrl } from "../../lib/agentToolRuntime.js"
import { withTransientHttpRetry } from "../../lib/withTransientHttpRetry.js"

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
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const token = await signUpstreamJwt({
    env,
    audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
    claims: {
      sub: `repo:${repositoryId}`,
      orgId,
      principal: "service",
      ...(extras?.workspaceId ? { workspaceId: extras.workspaceId } : {}),
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

/**
 * Lists files and directories at a path. Returns entries with name, path, type.
 */
export async function listFiles(
  repositoryId: string,
  orgId: string,
  path = "",
  extras?: CodesearchAuthExtras,
): Promise<FileEntry[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ""
  const res = await fetchWithAuth(
    `${codesearchBaseUrl()}/${repositoryId}/files${query}`,
    { method: "GET" },
    repositoryId,
    orgId,
    extras,
  )
  if (!res.ok) {
    const bodyText = await res.text()
    let detail = bodyText.trim()
    try {
      const parsed = JSON.parse(bodyText) as { error?: unknown }
      if (typeof parsed.error === "string" && parsed.error.length > 0) {
        detail = parsed.error
      }
    } catch {
      // non-JSON body; use raw text
    }
    throw new Error(
      `listFiles failed: ${res.status}${detail ? `: ${detail}` : ""}`,
    )
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
    const bodyText = await res.text()
    let detail = bodyText.trim()
    try {
      const parsed = JSON.parse(bodyText) as { error?: unknown }
      if (typeof parsed.error === "string" && parsed.error.length > 0) {
        detail = parsed.error
      }
    } catch {
      // non-JSON body; use raw text
    }
    throw new CodesearchCheckoutError(
      `globFiles failed: ${res.status}${detail ? `: ${detail}` : ""}`,
      res.status,
    )
  }
  return (await res.json()) as GlobFilesResponse
}

/** Fail-fast glob of the codesearch checkout. Pass workspaceId for `ws:<id>`. */
export async function globCheckoutFiles(input: {
  repositoryId: string
  orgId: string
  workspaceId?: string
  request?: GlobFilesRequest
}): Promise<GlobFilesResponse> {
  return globFiles(
    input.repositoryId,
    input.orgId,
    input.request ?? { pattern: "**/*", onlyFiles: true, dot: true },
    { workspaceId: input.workspaceId, retries: 0 },
  )
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
    throw new CodesearchCheckoutError(
      `fetchFiles failed: ${res.status}`,
      res.status,
    )
  }
  const encoded = (await res.json()) as Record<string, string>
  const result: Record<string, string> = {}
  for (const [p, b64] of Object.entries(encoded)) {
    result[p] = Buffer.from(b64, "base64").toString("utf-8")
  }
  return result
}

/** Fail-fast file bytes from the codesearch checkout. Pass workspaceId for `ws:<id>`. */
export async function fetchCheckoutFileBytes(input: {
  repositoryId: string
  orgId: string
  workspaceId?: string
  path: string
}): Promise<Uint8Array | null> {
  const res = await fetchWithAuth(
    `${codesearchBaseUrl()}/${input.repositoryId}/files-query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [input.path] }),
    },
    input.repositoryId,
    input.orgId,
    { workspaceId: input.workspaceId, retries: 0 },
  )
  if (!res.ok) {
    throw new CodesearchCheckoutError(
      `fetchCheckoutFileBytes failed: ${res.status}`,
      res.status,
    )
  }
  const encoded = (await res.json()) as Record<string, string>
  const b64 = encoded[input.path]
  if (!b64) return null
  return Buffer.from(b64, "base64")
}
