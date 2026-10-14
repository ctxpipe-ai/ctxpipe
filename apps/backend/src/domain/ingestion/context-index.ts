import { spawn } from "node:child_process"
import { listWorkspaceUnitsAtRevision } from "../../models/workspaces.js"
import {
  hydrateKnowledgeTree,
  resolveHydrateLink,
} from "../workspaces/hydrate.js"
import {
  fileOwnership,
  fileSources,
  parseYamlObject,
  splitFrontMatter,
} from "./patch-validator.js"
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
  /** Normalized source URLs of a generated file. */
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

/** Reads the raw files of a git revision with one `git cat-file --batch`. */
export async function readGitFiles(
  repoDir: string,
  sha: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
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
  child.stdin.end(paths.map((path) => `${sha}:${path}\n`).join(""))
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

/** Pure step: the entries of the given raw files for one source. */
export function buildContextIndexEntries(input: {
  units: ReadonlyArray<{ path: string; kind: string | null; links: string[] }>
  raw: ReadonlyMap<string, string>
  sourceUrl: string
}): ContextIndexEntry[] {
  const paths = new Set(input.units.map((unit) => unit.path))
  return input.units.map(({ path, kind, links }) => {
    const raw = input.raw.get(path) ?? ""
    const dir = path.split("/").slice(0, -1).join("/")
    // A claim target is a link too: the agent finds an API's operations.
    const resolved = [
      ...new Set(
        [...links, ...claimTargets(raw)].map((href) =>
          resolveHydrateLink(dir, href),
        ),
      ),
    ]
      .filter((target) => target !== path && paths.has(target))
      .sort()
    return {
      path,
      kind,
      title: titleOf(raw),
      summary: summaryOf(raw),
      links: resolved.slice(0, MAX_LINKS),
      sources: fileSources(raw).slice(0, MAX_SOURCES),
      owned: fileOwnership(raw, input.sourceUrl) !== "foreign",
    }
  })
}

type IndexUnit = { path: string; kind: string | null; links: string[] }

/**
 * The units of the index at the step base: the projection at the pinned
 * revision, with each file that changed between the pinned revision and the
 * base parsed again as hydrate parses it. A deleted file has no unit.
 */
export function unitsAtStepBase(input: {
  workspaceId: string
  projection: readonly IndexUnit[]
  changed: ReadonlyArray<{ path: string; content: string | null }>
}): IndexUnit[] {
  const units = new Map(input.projection.map((unit) => [unit.path, unit]))
  for (const { path } of input.changed) units.delete(path)
  const { units: parsed } = hydrateKnowledgeTree({
    workspaceId: input.workspaceId,
    files: input.changed.flatMap((file) =>
      file.content === null ? [] : [{ path: file.path, content: file.content }],
    ),
  })
  for (const unit of parsed)
    units.set(unit.path, {
      path: unit.path,
      kind: unit.kind,
      links: unit.links,
    })
  return [...units.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )
}

/** The paths that changed between two commits of `repoDir`, with their text at `base`. */
async function changedFiles(
  repoDir: string,
  pinnedRevision: string,
  base: string,
): Promise<Array<{ path: string; content: string | null }>> {
  if (base === pinnedRevision) return []
  const out = (
    await runGit(repoDir, [
      "diff-tree",
      "-r",
      "-z",
      "--no-renames",
      "--name-status",
      pinnedRevision,
      base,
    ])
  ).toString("utf8")
  const fields = out.split("\0").filter(Boolean)
  const deleted: string[] = []
  const written: string[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i] ?? ""
    const path = fields[i + 1] ?? ""
    if (status.startsWith("D")) deleted.push(path)
    else written.push(path)
  }
  const raw = await readGitFiles(repoDir, base, written)
  return [
    ...deleted.map((path) => ({ path, content: null })),
    ...written.map((path) => ({ path, content: raw.get(path) ?? null })),
  ]
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
  sourceUrl: string
  repoDir: string
}): Promise<{ index: ContextIndex; json: string }> {
  const units = unitsAtStepBase({
    workspaceId: input.workspaceId,
    projection: input.projection,
    changed: await changedFiles(
      input.repoDir,
      input.pinnedRevision,
      input.base,
    ),
  })
  const raw = await readGitFiles(
    input.repoDir,
    input.base,
    units.map((unit) => unit.path),
  )
  return renderContextIndex({
    workspaceId: input.workspaceId,
    revision: input.base,
    entries: buildContextIndexEntries({
      units,
      raw,
      sourceUrl: input.sourceUrl,
    }),
  })
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
  sourceUrl: string
  repoDir: string
}): Promise<{ index: ContextIndex; json: string }> {
  return contextIndexAtStepBase({
    workspaceId: input.workspaceId,
    projection: await listWorkspaceUnitsAtRevision(
      input.workspaceId,
      input.sha,
    ),
    pinnedRevision: input.sha,
    base: input.base ?? input.sha,
    sourceUrl: input.sourceUrl,
    repoDir: input.repoDir,
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
