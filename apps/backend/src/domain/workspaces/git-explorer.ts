import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

export type WorkspaceGitExplorerTarget = {
  sha: string
  url: string
  repositoryName: string | null
  githubConnectionId: string | null
}

export type WorkspaceGitExplorerResult =
  | { ok: true; target: WorkspaceGitExplorerTarget }
  | { ok: false; status: 409; error: string }

export type ExplorerGitFile =
  | { kind: "missing" }
  | { kind: "omitted" }
  | { kind: "bytes"; bytes: Uint8Array }

function workspaceExplorerRemote(input: {
  workspaceRepositoryUrl: string
  activeProjectionUrl: string | null
  activeProjectionSha: string | null
  desiredSha: string | null
}): { url: string; sha: string } | null {
  const activeSha = input.activeProjectionSha?.trim()
  if (activeSha) {
    const activeUrl = input.activeProjectionUrl?.trim()
    return {
      url: activeUrl || input.workspaceRepositoryUrl,
      sha: activeSha,
    }
  }
  const desiredSha = input.desiredSha?.trim()
  if (!desiredSha) return null
  return { url: input.workspaceRepositoryUrl, sha: desiredSha }
}

export function workspaceExplorerSha(input: {
  activeProjectionSha: string | null
  desiredSha: string | null
}): string | null {
  const active = input.activeProjectionSha?.trim()
  if (active) return active
  const desired = input.desiredSha?.trim()
  return desired || null
}

export function workspaceGitExplorerTarget(input: {
  workspaceRepositoryUrl: string
  activeProjectionUrl: string | null
  githubConnectionId: string | null
  activeProjectionSha: string | null
  desiredSha: string | null
}): WorkspaceGitExplorerResult {
  const remote = workspaceExplorerRemote(input)
  if (!remote) {
    return {
      ok: false,
      status: 409,
      error: "This Workspace has no git SHA to browse yet.",
    }
  }
  return {
    ok: true,
    target: {
      sha: remote.sha,
      url: remote.url,
      repositoryName: githubRepoFullNameFromWorkspaceUrl(remote.url),
      githubConnectionId: input.githubConnectionId,
    },
  }
}

export function explorerBlobPath(raw: string): string | null {
  const path = raw.trim()
  if (!path) return null
  const parts = path.split("/")
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return null
  }
  if (path.startsWith("/") || path.includes("\\")) return null
  return path
}

export function explorerBlobFromBytes(
  bytes: Uint8Array,
): { body: string; binary: false } | { body: null; binary: true } {
  if (bytes.includes(0)) return { body: null, binary: true }
  try {
    return {
      body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      binary: false,
    }
  } catch {
    return { body: null, binary: true }
  }
}

export function explorerBlobFromGitFile(
  file: ExplorerGitFile,
): { body: string; binary: false } | { body: null; binary: true } | null {
  if (file.kind === "missing") return null
  if (file.kind === "omitted") return { body: null, binary: true }
  return explorerBlobFromBytes(file.bytes)
}

export function explorerBlobFromContent(
  content: string | undefined,
): { body: string; binary: false } | { body: null; binary: true } | null {
  if (content === undefined) return null
  return explorerBlobFromBytes(Buffer.from(content, "utf8"))
}

export const EXPLORER_GIT_STATUSES = [
  "added",
  "deleted",
  "ignored",
  "modified",
  "renamed",
  "untracked",
] as const

export type ExplorerGitStatus = (typeof EXPLORER_GIT_STATUSES)[number]

export type ExplorerGitStatusEntry = {
  path: string
  status: ExplorerGitStatus
  additions?: number
  deletions?: number
}

function porcelainPath(raw: string): string | null {
  const path = raw.includes(" -> ") ? (raw.split(" -> ").at(-1) ?? raw) : raw
  return explorerBlobPath(path.replace(/^"|"$/g, "").trim())
}

function porcelainStatus(code: string): ExplorerGitStatus | null {
  if (code === "??") return "untracked"
  if (code === "!!") return "ignored"
  if (code.includes("R")) return "renamed"
  if (code.includes("D") && !code.includes("A") && !code.includes("M")) {
    return "deleted"
  }
  if (code.includes("A") || code.includes("C")) return "added"
  if (code.includes("M") || code.includes("U")) return "modified"
  return null
}

export function explorerGitStatusFromPorcelain(
  stdout: string,
): ExplorerGitStatusEntry[] {
  const items: ExplorerGitStatusEntry[] = []
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd()
    if (line.length < 4) continue
    const status = porcelainStatus(line.slice(0, 2))
    const path = porcelainPath(line.slice(3))
    if (!status || !path) continue
    items.push({ path, status })
  }
  return items
}

export type ExplorerGitLineCounts = {
  additions: number
  deletions: number
}

/** Parse `git diff --numstat HEAD` (`added<tab>deleted<tab>path`). */
export function explorerGitNumstatFromStdout(
  stdout: string,
): Map<string, ExplorerGitLineCounts> {
  const counts = new Map<string, ExplorerGitLineCounts>()
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd()
    if (!line) continue
    const tabs = line.split("\t")
    if (tabs.length < 3) continue
    const addedRaw = tabs[0]
    const deletedRaw = tabs[1]
    const path = porcelainPath(tabs.slice(2).join("\t"))
    if (!path || addedRaw == null || deletedRaw == null) continue
    const additions = addedRaw === "-" ? 0 : Number.parseInt(addedRaw, 10)
    const deletions = deletedRaw === "-" ? 0 : Number.parseInt(deletedRaw, 10)
    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) continue
    counts.set(path, { additions, deletions })
  }
  return counts
}

export function withExplorerGitLineCounts(
  entry: ExplorerGitStatusEntry,
  counts: Map<string, ExplorerGitLineCounts>,
  body?: string | null,
): ExplorerGitStatusEntry {
  const fromDiff = counts.get(entry.path)
  if (fromDiff) return { ...entry, ...fromDiff }
  if (entry.status === "untracked" && body) {
    const lines =
      body === "" ? 0 : body.split("\n").length - (body.endsWith("\n") ? 1 : 0)
    return { ...entry, additions: lines, deletions: 0 }
  }
  if (entry.status === "deleted") {
    return { ...entry, additions: 0 }
  }
  return entry
}
