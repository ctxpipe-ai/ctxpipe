import { spawn } from "node:child_process"
import { listWorkspaceUnitsAtRevision } from "../../models/workspaces.js"
import { parseNameStatus } from "../../services/git/name-status.js"
import {
  hydrateKnowledgeTree,
  resolveHydrateLink,
} from "../workspaces/hydrate.js"
import { parseYamlObject, splitFrontMatter } from "./front-matter.js"
import { fileOwnership, fileSources } from "./patch-validator.js"
import { runGit } from "./run-git.js"

/**
 * The context index of one Workspace (CTX-584, concept section 4.2). The host
 * builds it from the active projection at the pinned revision, changed by the
 * files that the run's earlier steps wrote up to the step base (ADR-052
 * section 6), and stages it as `/ctxpipe/context/<workspaceId>.index.json`.
 * The agent reads it before it writes, so the file is compact and bounded.
 */

export type ContextIndexEntry = {
  path: string
  kind: string | null
  title: string | null
  /** One line from the front matter `summary` or `description`, else the first paragraph. */
  summary: string | null
  /** Paths of other units in the projection that this unit links to. */
  links: string[]
  /**
   * Source file paths (`sources`) of a generated file (ADR-050 revision
   * 2026-10-16).
   */
  sources: string[]
  /** True when the run's source owns the file. */
  owned: boolean
}

export type ContextIndex = {
  workspaceId: string
  revision: string
  /** Units in the projection, also when the cap leaves some out. */
  total: number
  /** True when the cap left entries out. Owned entries stay first. */
  truncated: boolean
  entries: ContextIndexEntry[]
}

/** Entry cap. Owned entries are kept first, then the others in path order. */
export const CONTEXT_INDEX_MAX_ENTRIES = 2000
/** Cap on the JSON size. The index drops entries from the end to fit. */
export const CONTEXT_INDEX_MAX_BYTES = 256 * 1024
const MAX_TITLE = 120
const MAX_SUMMARY = 160
const MAX_SOURCES = 5
const MAX_LINKS = 10

/**
 * Reads the raw files of a git revision with one `git cat-file --batch`.
 * `paths` and the keys of the result are relative to `rootPath`.
 */
export async function readGitFiles(
  repoDir: string,
  sha: string,
  paths: readonly string[],
  rootPath = "",
): Promise<Map<string, string>> {
  const prefix = rootPath ? `${rootPath}/` : ""
  const result = new Map<string, string>()
  if (paths.length === 0) return result
  const child = spawn("git", ["-C", repoDir, "cat-file", "--batch"], {
    stdio: ["pipe", "pipe", "ignore"],
  })
  const chunks: Buffer[] = []
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", () => resolve())
  })
  child.stdin.end(paths.map((path) => `${sha}:${prefix}${path}\n`).join(""))
  await exited
  const out = Buffer.concat(chunks)
  let at = 0
  for (const path of paths) {
    const end = out.indexOf(10, at)
    if (end < 0) break
    const header = out.toString("utf8", at, end)
    at = end + 1
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(header)
    if (!match) continue // "<name> missing": the file has no blob at the revision
    const size = Number(match[1])
    result.set(path, out.toString("utf8", at, at + size))
    at += size + 1
  }
  return result
}

function oneLine(text: string | undefined, max: number): string | null {
  const line = text?.replace(/\s+/g, " ").trim()
  return line ? line.slice(0, max) : null
}

function summaryOf(raw: string): string | null {
  const front = splitFrontMatter(raw)
  const attributes = front ? parseYamlObject(front.yaml) : null
  for (const key of ["summary", "description"]) {
    const value = attributes?.[key]
    if (typeof value === "string" && value.trim())
      return oneLine(value, MAX_SUMMARY)
  }
  const paragraph = (front ? front.body : raw)
    .split(/\n[ \t]*\n/)
    .map((block) => block.trim())
    .find(
      (block) =>
        block &&
        !/^#/.test(block) &&
        !/^<!--/.test(block) &&
        !/^[-*]{3,}$/.test(block),
    )
  return oneLine(paragraph, MAX_SUMMARY)
}

function claimTargets(raw: string): string[] {
  const front = splitFrontMatter(raw)
  const claims = front ? parseYamlObject(front.yaml)?.claims : undefined
  return Array.isArray(claims)
    ? claims.flatMap((claim) =>
        claim &&
        typeof claim === "object" &&
        typeof (claim as { to?: unknown }).to === "string"
          ? [(claim as { to: string }).to]
          : [],
      )
    : []
}

function titleOf(raw: string): string | null {
  const front = splitFrontMatter(raw)
  const name = front ? parseYamlObject(front.yaml)?.name : undefined
  const text =
    typeof name === "string" && name.trim()
      ? name
      : /^#{1,6}[ \t]+(.+?)[ \t]*$/m.exec(front ? front.body : raw)?.[1]
  const title = text?.replace(/\s+/g, " ").trim()
  return title ? title.slice(0, MAX_TITLE) : null
}

/** One entry of a unit; its links hold each resolved target in the text. */
function entryOf(
  unit: IndexUnit,
  raw: string,
  sourcePath: string,
): ContextIndexEntry {
  const dir = unit.path.split("/").slice(0, -1).join("/")
  // A claim target is a link too: the agent finds an API's operations.
  const links = [
    ...new Set(
      [...unit.links, ...claimTargets(raw)].map((href) =>
        resolveHydrateLink(dir, href),
      ),
    ),
  ]
    .filter((target) => target !== unit.path)
    .sort()
  return {
    path: unit.path,
    kind: unit.kind,
    title: titleOf(raw),
    summary: summaryOf(raw),
    links,
    sources: fileSources(raw).slice(0, MAX_SOURCES),
    owned: fileOwnership(raw, sourcePath) !== "foreign",
  }
}

/** Keep only the links to other units of the index. */
function linkedEntries(
  entries: readonly ContextIndexEntry[],
): ContextIndexEntry[] {
  const paths = new Set(entries.map((entry) => entry.path))
  return entries.map((entry) => ({
    ...entry,
    links: entry.links
      .filter((target) => paths.has(target))
      .slice(0, MAX_LINKS),
  }))
}

/** Pure step: the entries of the given raw files for one source. */
export function buildContextIndexEntries(input: {
  units: ReadonlyArray<{ path: string; kind: string | null; links: string[] }>
  raw: ReadonlyMap<string, string>
  sourcePath: string
}): ContextIndexEntry[] {
  return linkedEntries(
    input.units.map((unit) =>
      entryOf(unit, input.raw.get(unit.path) ?? "", input.sourcePath),
    ),
  )
}

type IndexUnit = { path: string; kind: string | null; links: string[] }

/** The units of written files, parsed as hydrate parses them. */
function parseUnits(
  workspaceId: string,
  files: ReadonlyArray<{ path: string; content: string }>,
): IndexUnit[] {
  return hydrateKnowledgeTree({ workspaceId, files: [...files] }).units.map(
    (unit) => ({ path: unit.path, kind: unit.kind ?? null, links: unit.links }),
  )
}

/**
 * The paths below `rootPath` that changed between two commits of `repoDir`,
 * relative to `rootPath`, with their text at `to`.
 */
async function changedFiles(
  repoDir: string,
  from: string,
  to: string,
  rootPath: string,
): Promise<Array<{ path: string; content: string | null }>> {
  if (from === to) return []
  const out = await runGit(repoDir, [
    "diff-tree",
    "-r",
    "-z",
    "--no-renames",
    "--name-status",
    from,
    to,
    ...(rootPath ? ["--", `${rootPath}/`] : []),
  ])
  const prefixLength = rootPath ? rootPath.length + 1 : 0
  const deleted: string[] = []
  const written: string[] = []
  for (const change of parseNameStatus(out)) {
    const { status } = change
    const path = change.to.slice(prefixLength)
    if (status.startsWith("D")) deleted.push(path)
    else written.push(path)
  }
  const raw = await readGitFiles(repoDir, to, written, rootPath)
  return [
    ...deleted.map((path) => ({ path, content: null })),
    ...written.map((path) => ({ path, content: raw.get(path) ?? null })),
  ]
}

/**
 * The index of each step of one Workspace in one shard (ADR-052 section 6).
 * It keeps one scratch repository and one projection: the first call reads
 * the projection at the pinned revision; each later call fetches only the
 * commits that the scratch repository does not have, and parses again only
 * the files that changed since the last base. `fetch` puts `what` (a SHA or
 * a ref name) at the local ref `into`, so the next fetch tells the remote
 * what the repository has. `parsed` counts the files parsed again.
 */
export function stepContextIndex(source: {
  workspaceId: string
  pinnedRevision: string
  sourcePath: string
  repoDir: string
  /** Workspace root folder; unit paths are relative to it. */
  rootPath?: string
  projection: () => Promise<readonly IndexUnit[]>
  fetch: (what: string, into: string) => Promise<void>
}) {
  let state: {
    base: string
    entries: Map<string, ContextIndexEntry>
  } | null = null
  let fetches = 0
  let queue: Promise<unknown> = Promise.resolve()
  // A test may pin the empty tree, so any object counts.
  const has = (object: string) =>
    runGit(source.repoDir, ["cat-file", "-e", object]).then(
      () => true,
      () => false,
    )
  const fetchInto = (what: string) =>
    source.fetch(what, `refs/ctxpipe-index/${fetches++}`)

  const at = async (base: string, ref?: string) => {
    if (!state) {
      if (!(await has(source.pinnedRevision)))
        await fetchInto(source.pinnedRevision)
      const units = await source.projection()
      const raw = await readGitFiles(
        source.repoDir,
        source.pinnedRevision,
        units.map((unit) => unit.path),
        source.rootPath,
      )
      state = {
        base: source.pinnedRevision,
        entries: new Map(
          units.map((unit) => [
            unit.path,
            entryOf(unit, raw.get(unit.path) ?? "", source.sourcePath),
          ]),
        ),
      }
    }
    if (base !== state.base) {
      if (ref && !(await has(base))) await fetchInto(ref)
      if (!(await has(base))) await fetchInto(base)
      const changed = await changedFiles(
        source.repoDir,
        state.base,
        base,
        source.rootPath ?? "",
      )
      for (const { path } of changed) state.entries.delete(path)
      const written = changed.flatMap((file) =>
        file.content === null
          ? []
          : [{ path: file.path, content: file.content }],
      )
      builder.parsed += written.length
      const text = new Map(written.map((file) => [file.path, file.content]))
      for (const unit of parseUnits(source.workspaceId, written))
        state.entries.set(
          unit.path,
          entryOf(unit, text.get(unit.path) ?? "", source.sourcePath),
        )
      state.base = base
    }
    return renderContextIndex({
      workspaceId: source.workspaceId,
      revision: base,
      entries: linkedEntries([...state.entries.values()]),
    })
  }

  const builder = {
    parsed: 0,
    /** The index at `base`; `ref` is the run ref that holds `base`. */
    at(
      base: string,
      ref?: string,
    ): Promise<{ index: ContextIndex; json: string }> {
      // One step at a time: each call starts from the last base.
      const next = queue.then(() => at(base, ref))
      queue = next.catch(() => undefined)
      return next
    },
  }
  return builder
}

/**
 * Builds the index of a step from the projection at the pinned revision and
 * the commits from there to `base` (the step base) in `repoDir`. The result
 * depends only on the two commits and the source, so the same input gives
 * the same JSON.
 */
export async function contextIndexAtStepBase(input: {
  workspaceId: string
  projection: readonly IndexUnit[]
  pinnedRevision: string
  base: string
  sourcePath: string
  repoDir: string
  rootPath?: string
}): Promise<{ index: ContextIndex; json: string }> {
  return stepContextIndex({
    ...input,
    projection: async () => input.projection,
    fetch: async (what) => {
      throw new Error(`The repository does not hold ${what}`)
    },
  }).at(input.base)
}

/**
 * Builds the index of a step: the units projected at `sha` (the pinned
 * revision) from the database, changed by the commits up to `base` (the step
 * base; the pinned revision when absent). `repoDir` holds both commits.
 */
export async function buildContextIndex(input: {
  workspaceId: string
  sha: string
  base?: string
  sourcePath: string
  repoDir: string
  /** Workspace root folder; unit paths are relative to it. */
  rootPath?: string
}): Promise<{ index: ContextIndex; json: string }> {
  return contextIndexAtStepBase({
    workspaceId: input.workspaceId,
    projection: await listWorkspaceUnitsAtRevision(
      input.workspaceId,
      input.sha,
    ),
    pinnedRevision: input.sha,
    base: input.base ?? input.sha,
    sourcePath: input.sourcePath,
    repoDir: input.repoDir,
    rootPath: input.rootPath,
  })
}

function renderContextIndex(input: {
  workspaceId: string
  revision: string
  entries: ContextIndexEntry[]
}): { index: ContextIndex; json: string } {
  const all = input.entries
  // Keep owned entries first when a cap applies; then restore path order.
  const ranked = [...all].sort(
    (a, b) =>
      Number(b.owned) - Number(a.owned) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  )
  let kept = ranked.slice(0, CONTEXT_INDEX_MAX_ENTRIES)
  const render = (entries: ContextIndexEntry[]) => {
    const index: ContextIndex = {
      workspaceId: input.workspaceId,
      revision: input.revision,
      total: all.length,
      truncated: entries.length < all.length,
      entries: [...entries].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
    }
    return { index, json: JSON.stringify(index) }
  }
  let rendered = render(kept)
  while (
    Buffer.byteLength(rendered.json) > CONTEXT_INDEX_MAX_BYTES &&
    kept.length > 0
  ) {
    // Drop about 10% of the lowest-ranked entries per pass.
    kept = kept.slice(0, Math.floor(kept.length * 0.9))
    rendered = render(kept)
  }
  return rendered
}
