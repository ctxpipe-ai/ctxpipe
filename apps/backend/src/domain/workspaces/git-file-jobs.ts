import { explorerBlobPath } from "./git-explorer.js"

export type WorkspaceFileJobRequest =
  | { op: "save"; path: string; content: string }
  | {
      op: "create"
      path: string
      kind: "file" | "folder"
      content?: string
    }
  | { op: "rename"; from: string; to: string }
  | { op: "move"; from: string; toDirectory: string | null }
  | { op: "delete"; path: string }

export function parseWorkspaceFileJobRequest(body: {
  op: "save" | "create" | "rename" | "move" | "delete"
  path?: string
  content?: string
  kind?: "file" | "folder"
  from?: string
  to?: string
  toDirectory?: string | null
}): WorkspaceFileJobRequest | null {
  if (body.op === "save" && body.path != null && body.content != null) {
    return { op: "save", path: body.path, content: body.content }
  }
  if (body.op === "create" && body.path != null && body.kind) {
    return {
      op: "create",
      path: body.path,
      kind: body.kind,
      ...(body.content != null ? { content: body.content } : {}),
    }
  }
  if (body.op === "rename" && body.from && body.to) {
    return { op: "rename", from: body.from, to: body.to }
  }
  if (body.op === "move" && body.from && body.toDirectory !== undefined) {
    return { op: "move", from: body.from, toDirectory: body.toDirectory }
  }
  if (body.op === "delete" && body.path) {
    return { op: "delete", path: body.path }
  }
  return null
}

export type WorkspaceFileJobPlan = {
  mergeFiles: Array<{ path: string; content: string }>
  mergeDeletePaths: string[]
}

export type WorkspaceFileJobResult =
  | { ok: true; plan: WorkspaceFileJobPlan }
  | { ok: false; error: string }

const PATH_REQUIRED = "A valid file path is required"

export function explorerChildPath(
  parentDir: string | null,
  name: string,
): string | null {
  const cleaned = name.trim().replaceAll("\\", "/")
  if (!cleaned || cleaned.includes("/")) return null
  const full = parentDir ? `${parentDir}/${cleaned}` : cleaned
  return explorerBlobPath(full)
}

export function explorerPathsAt(
  treePaths: readonly string[],
  target: string,
): string[] {
  if (treePaths.includes(target)) return [target]
  const prefix = `${target}/`
  return treePaths.filter((path) => path.startsWith(prefix))
}

export function explorerRewritePrefix(
  path: string,
  from: string,
  to: string,
): string {
  if (path === from) return to
  const prefix = `${from}/`
  if (path.startsWith(prefix)) return `${to}/${path.slice(prefix.length)}`
  return path
}

function basename(path: string): string {
  return path.split("/").pop() ?? path
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

export async function planWorkspaceFileJob(input: {
  request: WorkspaceFileJobRequest
  treePaths: readonly string[]
  readBlob: (path: string) => Promise<string | null>
}): Promise<WorkspaceFileJobResult> {
  const { request, treePaths, readBlob } = input
  if (request.op === "save") {
    const path = explorerBlobPath(request.path)
    if (!path) return { ok: false, error: PATH_REQUIRED }
    return {
      ok: true,
      plan: {
        mergeFiles: [{ path, content: request.content }],
        mergeDeletePaths: [],
      },
    }
  }
  if (request.op === "create") {
    const path = explorerBlobPath(request.path)
    if (!path) return { ok: false, error: PATH_REQUIRED }
    if (explorerPathsAt(treePaths, path).length > 0) {
      return { ok: false, error: "That path already exists." }
    }
    const writePath = request.kind === "folder" ? `${path}/.gitkeep` : path
    if (!explorerBlobPath(writePath)) {
      return { ok: false, error: PATH_REQUIRED }
    }
    return {
      ok: true,
      plan: {
        mergeFiles: [{ path: writePath, content: request.content ?? "" }],
        mergeDeletePaths: [],
      },
    }
  }
  if (request.op === "delete") {
    const path = explorerBlobPath(request.path)
    if (!path) return { ok: false, error: PATH_REQUIRED }
    const mergeDeletePaths = explorerPathsAt(treePaths, path)
    if (mergeDeletePaths.length === 0) {
      return { ok: false, error: "That path is not in the git tree." }
    }
    return { ok: true, plan: { mergeFiles: [], mergeDeletePaths } }
  }
  if (request.op === "rename" || request.op === "move") {
    const from = explorerBlobPath(request.from)
    if (!from) return { ok: false, error: PATH_REQUIRED }
    const to =
      request.op === "rename"
        ? explorerBlobPath(request.to)
        : explorerChildPath(request.toDirectory, basename(from))
    if (!to) return { ok: false, error: PATH_REQUIRED }
    if (from === to) {
      return { ok: false, error: "Source and destination are the same path." }
    }
    if (isInside(from, to)) {
      return { ok: false, error: "Cannot move a folder into itself." }
    }
    if (explorerPathsAt(treePaths, to).length > 0) {
      return { ok: false, error: "That path already exists." }
    }
    const sources = explorerPathsAt(treePaths, from)
    if (sources.length === 0) {
      return { ok: false, error: "That path is not in the git tree." }
    }
    const mergeFiles: Array<{ path: string; content: string }> = []
    for (const source of sources) {
      const content = await readBlob(source)
      if (content == null) {
        return { ok: false, error: "Could not read this path to move it." }
      }
      const dest = explorerRewritePrefix(source, from, to)
      if (!explorerBlobPath(dest)) return { ok: false, error: PATH_REQUIRED }
      mergeFiles.push({ path: dest, content })
    }
    return {
      ok: true,
      plan: { mergeFiles, mergeDeletePaths: sources },
    }
  }
  return { ok: false, error: PATH_REQUIRED }
}
