import { signUpstreamJwt } from "../../auth/upstreamJwt.js"
import { parseEnv } from "../../config/env.js"
import { codesearchBaseUrl } from "../../lib/agentToolRuntime.js"

export type FileEntry = { name: string; path: string; type: "file" | "dir" }

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
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  })
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
    throw new Error(`listFiles failed: ${res.status}`)
  }
  const data = (await res.json()) as { entries: FileEntry[] }
  return data.entries
}

/**
 * Recursively lists all file paths under a directory.
 */
export async function listFilesRecursive(
  repositoryId: string,
  orgId: string,
  path = "",
): Promise<string[]> {
  const entries = await listFiles(repositoryId, orgId, path)
  const files: string[] = []
  for (const e of entries) {
    if (e.type === "file") {
      files.push(e.path)
    } else if (e.type === "dir") {
      const sub = await listFilesRecursive(repositoryId, orgId, e.path)
      files.push(...sub)
    }
  }
  return files
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
    throw new Error(`fetchFiles failed: ${res.status}`)
  }
  const encoded = (await res.json()) as Record<string, string>
  const result: Record<string, string> = {}
  for (const [p, b64] of Object.entries(encoded)) {
    result[p] = Buffer.from(b64, "base64").toString("utf-8")
  }
  return result
}
