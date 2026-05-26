import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, openSync, closeSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import {
  ensureRepoStateDir,
  hydrationLockFile,
  hydrationManifestFile,
  resolveMemoryRoot,
  type RepoFingerprint,
} from "./paths.js"
import {
  MarkdownParseError,
  parseRecord,
  serializeRecord,
  type MemoryRecord,
} from "./markdown.js"

export const DEFAULT_DELTA_FILE_THRESHOLD = 50
export const DEFAULT_DELTA_RATIO_THRESHOLD = 0.1
/**
 * Minimum absolute delta below which we always prefer merge over replace, even
 * for tiny corpora. Without this floor, a 2-file repo where the user edits 1
 * file (50%) would always trigger `replace`, which makes interactive use feel
 * sluggish. See acceptance test "classifies a single edit as a small merge
 * import".
 */
const DELTA_FLOOR = 10
const MANIFEST_SCHEMA_VERSION = 1

export type ManifestFileEntry = {
  hash: string
  mtimeMs: number
  size: number
  memoryIds: string[]
}

export type HydrationManifest = {
  schemaVersion: number
  memoryRoot: string
  repoId: string
  agentmemoryVersion: string | null
  lastHydratedAt: string | null
  gitHead: string | null
  files: Record<string, ManifestFileEntry>
}

export type DeltaClassification =
  | { kind: "noop"; reason: "manifest-matches-tree" }
  | {
      kind: "small"
      changedFiles: string[]
      deletedFiles: string[]
      deletedMemoryIds: string[]
    }
  | {
      kind: "large"
      changedFiles: string[]
      deletedFiles: string[]
      deletedMemoryIds: string[]
      reason: "missing-manifest" | "above-threshold" | "schema-mismatch"
    }
  | {
      kind: "refuse"
      reason: "duplicate-id" | "merge-conflict" | "parse-error"
      details: Array<{ file: string; id?: string; message?: string }>
    }

export type ImportPayload = {
  strategy: "merge" | "replace"
  exportData: {
    version: string
    exportedAt: string
    sessions: never[]
    observations: Record<string, never>
    summaries: never[]
    memories: Array<{
      id: string
      createdAt: string
      updatedAt: string
      type: string
      title: string
      content: string
      concepts: string[]
      files: string[]
      sessionIds: never[]
      strength: number
      version: number
      isLatest: boolean
    }>
  }
  deletedIds: string[]
}

export type ScanResult = {
  records: MemoryRecord[]
  recordsByPath: Map<string, MemoryRecord>
  fileEntries: Record<string, ManifestFileEntry>
  conflicts: Array<{ id: string; files: string[] }>
  parseErrors: Array<{ file: string; message: string }>
  mergeConflicts: string[]
}

/** List every Markdown file under memoryRoot and parse them. */
export function scanMemoryTree(memoryRoot: string): ScanResult {
  const records: MemoryRecord[] = []
  const recordsByPath = new Map<string, MemoryRecord>()
  const fileEntries: Record<string, ManifestFileEntry> = {}
  const idCounts = new Map<string, string[]>()
  const parseErrors: Array<{ file: string; message: string }> = []
  const mergeConflicts: string[] = []

  if (!existsSync(memoryRoot)) {
    return {
      records,
      recordsByPath,
      fileEntries,
      conflicts: [],
      parseErrors,
      mergeConflicts,
    }
  }

  for (const file of walkMarkdown(memoryRoot)) {
    const relPath = relative(memoryRoot, file).split(sep).join("/")
    let raw: string
    try {
      raw = readFileSync(file, "utf8")
    } catch (err) {
      parseErrors.push({
        file: relPath,
        message: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    let record: MemoryRecord
    try {
      record = parseRecord(raw, relPath)
    } catch (err) {
      if (err instanceof MarkdownParseError && /merge conflict/.test(err.message)) {
        mergeConflicts.push(relPath)
        continue
      }
      parseErrors.push({
        file: relPath,
        message: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    records.push(record)
    recordsByPath.set(relPath, record)
    const existingFiles = idCounts.get(record.id) ?? []
    existingFiles.push(relPath)
    idCounts.set(record.id, existingFiles)
    const stat = statSync(file)
    fileEntries[relPath] = {
      hash: hashContent(raw),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      memoryIds: [record.id],
    }
  }

  const conflicts: Array<{ id: string; files: string[] }> = []
  for (const [id, files] of idCounts) {
    if (files.length > 1) {
      conflicts.push({ id, files: files.slice().sort() })
    }
  }

  return {
    records,
    recordsByPath,
    fileEntries,
    conflicts,
    parseErrors,
    mergeConflicts,
  }
}

function* walkMarkdown(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkMarkdown(full)
      continue
    }
    if (!entry.isFile()) continue
    if (!entry.name.endsWith(".md")) continue
    yield full
  }
}

function hashContent(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`
}

export function classifyDelta(args: {
  manifest: HydrationManifest | null
  scan: ScanResult
  /** When set, override the heuristic to force a particular outcome. */
  fileThreshold?: number
  ratioThreshold?: number
}): DeltaClassification {
  const { manifest, scan } = args
  const fileThreshold = args.fileThreshold ?? DEFAULT_DELTA_FILE_THRESHOLD
  const ratioThreshold = args.ratioThreshold ?? DEFAULT_DELTA_RATIO_THRESHOLD

  if (scan.mergeConflicts.length > 0) {
    return {
      kind: "refuse",
      reason: "merge-conflict",
      details: scan.mergeConflicts.map((file) => ({ file })),
    }
  }
  if (scan.conflicts.length > 0) {
    return {
      kind: "refuse",
      reason: "duplicate-id",
      details: scan.conflicts.flatMap((c) =>
        c.files.map((file) => ({ file, id: c.id })),
      ),
    }
  }
  if (scan.parseErrors.length > 0) {
    return {
      kind: "refuse",
      reason: "parse-error",
      details: scan.parseErrors,
    }
  }

  if (!manifest || manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return {
      kind: "large",
      changedFiles: Object.keys(scan.fileEntries).sort(),
      deletedFiles: [],
      deletedMemoryIds: [],
      reason: !manifest ? "missing-manifest" : "schema-mismatch",
    }
  }

  const oldPaths = new Set(Object.keys(manifest.files))
  const newPaths = new Set(Object.keys(scan.fileEntries))
  const changed: string[] = []
  const deleted: string[] = []
  const deletedIds: string[] = []

  for (const path of newPaths) {
    const old = manifest.files[path]
    const cur = scan.fileEntries[path]
    if (!cur) continue
    if (!old) {
      changed.push(path)
      continue
    }
    if (old.hash !== cur.hash || old.size !== cur.size) {
      changed.push(path)
    }
  }
  for (const path of oldPaths) {
    if (!newPaths.has(path)) {
      deleted.push(path)
      const entry = manifest.files[path]
      if (entry) deletedIds.push(...entry.memoryIds)
    }
  }

  if (changed.length === 0 && deleted.length === 0) {
    return { kind: "noop", reason: "manifest-matches-tree" }
  }

  const deltaCount = changed.length + deleted.length
  const corpus = Math.max(oldPaths.size, newPaths.size, 1)
  const ratioBound = Math.max(DELTA_FLOOR, Math.floor(ratioThreshold * corpus))
  const smallLimit = Math.min(fileThreshold, ratioBound)
  if (deltaCount > smallLimit) {
    return {
      kind: "large",
      changedFiles: Array.from(newPaths).sort(),
      deletedFiles: deleted.sort(),
      deletedMemoryIds: deletedIds,
      reason: "above-threshold",
    }
  }
  return {
    kind: "small",
    changedFiles: changed.sort(),
    deletedFiles: deleted.sort(),
    deletedMemoryIds: deletedIds,
  }
}

export function buildImportPayload(args: {
  strategy: "merge" | "replace"
  records: MemoryRecord[]
  deletedIds?: string[]
  agentmemoryVersion: string
  now?: Date
}): ImportPayload {
  const now = (args.now ?? new Date()).toISOString()
  return {
    strategy: args.strategy,
    deletedIds: args.deletedIds ?? [],
    exportData: {
      version: args.agentmemoryVersion,
      exportedAt: now,
      sessions: [],
      observations: {},
      summaries: [],
      memories: args.records.map((record) => ({
        id: agentMemoryId(record.id),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        type: record.type,
        title: record.title,
        content: record.body,
        concepts: record.concepts,
        files: record.files,
        sessionIds: [],
        strength: 7,
        version: 1,
        isLatest: true,
      })),
    },
  }
}

export function agentMemoryId(id: string): string {
  return id.startsWith("ctxpipe_") ? id : `ctxpipe_${id}`
}

export function readManifest(
  fingerprint: RepoFingerprint,
): HydrationManifest | null {
  const file = hydrationManifestFile(fingerprint)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, "utf8").trim()
    if (!raw) return null
    const parsed = JSON.parse(raw) as HydrationManifest
    if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) return parsed
    return parsed
  } catch {
    return null
  }
}

export function writeManifest(
  fingerprint: RepoFingerprint,
  manifest: HydrationManifest,
): void {
  ensureRepoStateDir(fingerprint)
  const file = hydrationManifestFile(fingerprint)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

export function buildManifestFromScan(args: {
  scan: ScanResult
  memoryRoot: string
  fingerprint: RepoFingerprint
  agentmemoryVersion: string
  gitHead?: string | null
  now?: Date
}): HydrationManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    memoryRoot: args.memoryRoot,
    repoId: args.fingerprint,
    agentmemoryVersion: args.agentmemoryVersion,
    lastHydratedAt: (args.now ?? new Date()).toISOString(),
    gitHead: args.gitHead ?? null,
    files: args.scan.fileEntries,
  }
}

export function computeManifestStats(fingerprint: RepoFingerprint): {
  exists: boolean
  fileCount: number
  memoryCount: number
  lastHydratedAt: string | null
} {
  const manifest = readManifest(fingerprint)
  if (!manifest) {
    return { exists: false, fileCount: 0, memoryCount: 0, lastHydratedAt: null }
  }
  const memoryCount = Object.values(manifest.files).reduce(
    (count, entry) => count + entry.memoryIds.length,
    0,
  )
  return {
    exists: true,
    fileCount: Object.keys(manifest.files).length,
    memoryCount,
    lastHydratedAt: manifest.lastHydratedAt,
  }
}

/** Acquire an exclusive lock file. Caller MUST call release(). */
export async function acquireHydrationLock(
  fingerprint: RepoFingerprint,
  timeoutMs = 15_000,
): Promise<{ release: () => void }> {
  ensureRepoStateDir(fingerprint)
  const file = hydrationLockFile(fingerprint)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const fd = openSync(file, "wx")
      return {
        release: () => {
          try {
            closeSync(fd)
          } catch {
            // ignored
          }
          try {
            writeFileSync(file, "")
          } catch {
            // ignored
          }
          try {
            // best-effort unlink — keeps state dir tidy
            require("node:fs").unlinkSync(file)
          } catch {
            // ignored
          }
        },
      }
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        await new Promise((r) => setTimeout(r, 25))
        continue
      }
      throw err
    }
  }
  throw new Error(
    `Could not acquire hydration lock within ${timeoutMs}ms (held by another ctxpipe process)`,
  )
}

export type CanonicalSaveInput = {
  id: string
  type: string
  title: string
  body: string
  concepts?: string[]
  files?: string[]
}

/** Write a memory record into .ai/memory/<type>/<id>.md (idempotent). */
export function writeCanonicalRecord(args: {
  cwd: string
  input: CanonicalSaveInput
  now?: Date
}): {
  path: string
  record: MemoryRecord
  wasUpdate: boolean
} {
  const memoryRoot = resolveMemoryRoot(args.cwd)
  if (!existsSync(memoryRoot)) mkdirSync(memoryRoot, { recursive: true })

  const typeDir = join(memoryRoot, slugify(args.input.type))
  if (!existsSync(typeDir)) mkdirSync(typeDir, { recursive: true })

  const file = join(typeDir, `${slugify(args.input.id)}.md`)
  const now = (args.now ?? new Date()).toISOString()

  const wasUpdate = existsSync(file)
  let createdAt = now
  if (wasUpdate) {
    try {
      const prior = parseRecord(readFileSync(file, "utf8"), file)
      createdAt = prior.createdAt
    } catch {
      // ignore malformed prior record; we overwrite
    }
  }

  const record: MemoryRecord = {
    id: args.input.id,
    type: args.input.type,
    title: args.input.title,
    body: args.input.body,
    concepts: args.input.concepts ?? [],
    files: args.input.files ?? [],
    createdAt,
    updatedAt: now,
    extra: {},
  }

  writeFileSync(file, serializeRecord(record), "utf8")
  return { path: file, record, wasUpdate }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

/** BM25-lite ranking for direct Markdown fallback when AgentMemory is down. */
export function searchCanonical(
  records: MemoryRecord[],
  query: string,
  limit = 10,
): Array<{ record: MemoryRecord; score: number }> {
  const tokens = tokenize(query)
  if (tokens.length === 0) return []
  const scored: Array<{ record: MemoryRecord; score: number }> = []
  for (const record of records) {
    const haystack = `${record.title}\n${record.body}\n${record.concepts.join(" ")}`.toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (token.length === 0) continue
      let idx = -1
      while ((idx = haystack.indexOf(token, idx + 1)) !== -1) {
        score += 1
      }
    }
    if (score > 0) scored.push({ record, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1)
}
