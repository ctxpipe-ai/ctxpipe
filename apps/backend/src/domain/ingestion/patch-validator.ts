import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { fromMarkdown } from "mdast-util-from-markdown"
import { parseDocument, stringify, type YAMLSeq } from "yaml"
import { z } from "zod"
import {
  DENIED_HEADINGS,
  INJECTION_PHRASES,
} from "../../../ingest-skills/bin/guard-patterns.mjs"
import { isConnectorMirrorPath } from "../codeIngestion/connectorMirrorPaths.js"
import { isHostOnlyPath } from "../workspaces/host-only.js"
import {
  KNOWLEDGE_KIND_FOLDERS,
  WORKFLOW_FILE_PATTERN,
} from "../workspaces/layout.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import { type AreaFile, checkAreaChange, parseAreaBody } from "./area-file.js"
import { parseYamlObject, splitFrontMatter } from "./front-matter.js"
import { GitOutputTooLargeError, runGit as git } from "./run-git.js"
import {
  findSuspectedSecret,
  type WorkMeter,
  withoutHumanText,
} from "./secret-scan.js"

export { findSuspectedSecret } from "./secret-scan.js"

/**
 * Host validation of one ingest step (CTX-584, ADR-052 section 2, concept
 * sections 3.1, 4.3, and 6). The host builds the ops again from the staged
 * tree, checks each op against the step's base commit, applies the accepted
 * ops on its own index, and returns the resulting tree.
 */

export type PatchRule =
  | "path"
  | "patch_json"
  | "base_blob_mismatch"
  | "ownership"
  | "additive_only"
  | "shared_file"
  | "human_section"
  | "front_matter"
  | "evidence"
  | "link"
  | "content"
  | "size_cap"
  | "op_cap"
  | "delete_cap"
  | "heading_denylist"
  | "suspected_injection"
  | "suspected_secret"

export type PatchRejection = { path: string; rule: PatchRule; reason: string }
export type AcceptedOp = { op: "create" | "update" | "delete"; path: string }

export type PatchStepResult = {
  tree: string
  accepted: AcceptedOp[]
  rejections: PatchRejection[]
  status: "complete" | "partial"
  /** `patch.json` says that files wait for a next page (ADR-052 section 6). */
  more: boolean
}

export type PatchStepInput = {
  /** Host checkout or bare repository of the Workspace context repository. */
  repoDir: string
  baseCommit: string
  /** Step output directory: `files/<path>` and `patch.json`. */
  stagedDir: string
  source: { url: string; sha: string }
  /**
   * The path of the run's source file in this Workspace, relative to the
   * Workspace root folder (`sources/github/<owner>/<name>.md`, ADR-050
   * revision 2026-10-16). Ownership compares it with `sources`, and the host
   * writes it as `sources` of each file that the step owns.
   */
  sourcePath: string
  skill: string
  bundle: string
  /**
   * True when `path` exists in the source repository at `source.sha`. With
   * `"blob"`, true only when it is a file: a folder or a gitlink is not.
   */
  sourcePathExists: (path: string, type?: "blob") => Promise<boolean>
  /**
   * The text of the file `path` in the source repository at `source.sha`, or
   * null when it is not a file or is too large to read.
   */
  readSourceFile: (path: string) => Promise<string | null>
  /** Ops that earlier steps of this run already wrote to this Workspace. */
  workspaceOpsBefore?: number
  /** The step's root is gone, so the delete cap does not apply. */
  rootGone?: boolean
  /** Repositories that the Workspace knows (sources and linked repositories). */
  linkableRepositories?: readonly string[]
  /**
   * The source root of a root step, from the host root-to-file map (`.` for
   * the repository top). The host writes it as `root` on each package unit.
   * A repository-wide step has no root and keeps the root of the base file.
   */
  root?: string
  /** Counts the characters that the text checks read, so a test can check the bound. */
  meter?: WorkMeter
  /**
   * Workspace root folder; `""` (the default) is the repository root. All
   * paths of the step (staged files, ops, results) are relative to it. Only
   * the git reads and the tree write add the folder.
   */
  rootPath?: string
}

/** The 13 allowlist folders and their kinds. Patterns are not extracted (ADR-052). */
const FOLDER_KINDS: ReadonlyMap<string, string> = new Map(
  Object.entries(KNOWLEDGE_KIND_FOLDERS)
    .filter(([kind]) => kind !== "Pattern")
    .map(([kind, folder]) => [folder, kind]),
)

const GENERATED_BY = "ctxpipe-extract"
/**
 * Folders whose files more than one root can write (ADR-052 section 6). A
 * root step (with a `root`) only claims them; a repository-wide step writes them.
 */
const SHARED_FOLDER =
  /^knowledge\/(?:streams|databases|infrastructure|instructions)\//
/** The kinds whose files get the host `root` (CTX-657). */
const PACKAGE_KINDS: ReadonlySet<string> = new Set([
  "Service",
  "App",
  "Library",
])
/** The front matter fields that only the host sets. */
export const HOST_FIELDS = [
  "generated_by",
  "sources",
  "root",
  "source_sha",
  "skill",
  "bundle",
] as const
const CONFIDENCE = { script: 0.7, model: 0.5 } as const
const MAX_FILE_BYTES = 64 * 1024
const MAX_STAGED_BYTES = 2 * 1024 * 1024
const MAX_PATCH_JSON_BYTES = 1024 * 1024
export const MAX_STEP_OPS = 30
export const MAX_WORKSPACE_OPS = 300
const MAX_DELETE_SHARE = 0.2
/** A source file above this size is not read to check a quote or a pattern. */
export const MAX_SOURCE_READ_BYTES = 1024 * 1024
/** Distinct source files that one step reads with git. */
const MAX_SOURCE_READS = 200
/** Total source text that one step reads with git (a source host download). */
const MAX_SOURCE_READ_TOTAL_BYTES = 16 * 1024 * 1024
/** Quotes and inferred-rule patterns that one step compares with source text. */
const MAX_SOURCE_COMPARES = 200
const HUMAN_OPEN = "<!-- ctxpipe:human -->"
const HUMAN_CLOSE = "<!-- /ctxpipe:human -->"

const EvidenceSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(500)
      .refine(
        (path) =>
          !path.startsWith("/") &&
          !path.includes("\\") &&
          !path.split("/").some((s) => s === "" || s === "." || s === ".."),
        "A relative source path is required",
      ),
    kind: z.enum(["script", "model"]),
  })
  .strict()

const ClaimSchema = z
  .object({
    to: z.string().min(1).max(500),
    predicate: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    evidence: EvidenceSchema,
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict()

type Claim = z.infer<typeof ClaimSchema>

/**
 * A claim that the ownership migration carried over from the old pipeline
 * (ADR-052 section 3). It keeps each old key, also `valid_from` and
 * `valid_to`. Only the host writes it: a step can keep it or leave it out,
 * but cannot add or change one.
 */
const LegacyClaimSchema = z
  .object({
    to: z.string().min(1),
    evidence: z.object({ kind: z.literal("legacy") }).strict(),
  })
  .passthrough()

const isLegacyClaim = (claim: unknown) =>
  LegacyClaimSchema.safeParse(claim).success

const FrontMatterSchema = z
  .object({
    kind: z.string(),
    name: z.string().min(1).max(200),
    summary: z.string().max(1000).optional(),
    claims: z
      .array(z.union([ClaimSchema, LegacyClaimSchema]))
      .refine(
        (claims) => claims.filter((c) => !isLegacyClaim(c)).length <= 200,
        "A file has at most 200 claims",
      )
      .optional(),
    /** The workflow file that a Workflow file describes, and no other kind. */
    workflow_file: z.string().optional(),
    generated_by: z.string().optional(),
    sources: z.array(z.string()).optional(),
    root: z.string().optional(),
    source_sha: z.string().optional(),
    skill: z.string().optional(),
    bundle: z.string().optional(),
  })
  .strict()

const PatchJsonSchema = z.object({
  ops: z
    .array(
      z.object({
        op: z.enum(["create", "update", "delete"]),
        path: z.string(),
        baseBlob: z.string().optional(),
        reason: z.string().optional(),
      }),
    )
    .max(10_000),
  more: z.boolean().optional(),
})

/** Ownership of a file at the base commit, from the host-only fields. */
type FileOwnership = "sole" | "shared" | "foreign"

/**
 * The text of one `sources` value as ownership compares it: a source file
 * path relative to the Workspace root folder (ADR-050 revision 2026-10-16,
 * ADR-052 section 3). Only white space at the ends goes.
 */
export function sourceIdentity(value: string): string {
  return value.trim()
}

/**
 * Shared ownership predicate (concept section 4.3). `sourcePath` is the path
 * of the run's source file in this Workspace. A file is owned when it has
 * `generated_by: ctxpipe-extract` and its `sources` list holds that path.
 */
export function fileOwnership(raw: string, sourcePath: string): FileOwnership {
  const sources = fileSources(raw)
  if (!sources.includes(sourceIdentity(sourcePath))) return "foreign"
  return new Set(sources).size === 1 ? "sole" : "shared"
}

/**
 * The source paths a generated file lists; empty for a file ctxpipe does not
 * generate.
 */
export function fileSources(raw: string): string[] {
  const front = splitFrontMatter(raw)
  const attributes = front ? parseYamlObject(front.yaml) : null
  if (!attributes || attributes.generated_by !== GENERATED_BY) return []
  return Array.isArray(attributes.sources)
    ? attributes.sources
        .filter((s): s is string => typeof s === "string")
        .map(sourceIdentity)
    : []
}

/** Path check of concept section 3.1; returns a reason or null. */
export function disallowedPathReason(path: string): string | null {
  if (!path || path.includes("\\") || path.startsWith("/"))
    return "The path must be a relative POSIX path"
  const segments = path.split("/")
  if (segments.some((s) => s === "" || s === "." || s === ".."))
    return "The path has an empty, '.', or '..' segment"
  if (isHostOnlyPath(path)) return "Only ctxpipe writes host-only paths"
  if (segments.some((s) => s.startsWith(".")))
    return "Dot paths are not allowed"
  if (path !== path.normalize("NFC"))
    return "The path must be in Unicode NFC form"
  // The allowlist below also rejects mirror roots; this check gives a clearer reason.
  if (isConnectorMirrorPath(path))
    return "Connector mirror folders belong to their connector"
  const base = segments.at(-1) ?? ""
  if (/^(agents|claude)\.md$/i.test(base))
    return "Agent instruction files are not allowed"
  if (
    segments.length < 3 ||
    segments[0] !== "knowledge" ||
    !FOLDER_KINDS.has(segments[1] ?? "")
  )
    return "Only the knowledge folders of the allowlist are allowed"
  if (!base.endsWith(".md")) return "Only Markdown files are allowed"
  return null
}

/** Reads the source repository at `sha` with `git cat-file`. */
export function gitSource(
  repoDir: string,
  sha: string,
): Pick<PatchStepInput, "sourcePathExists" | "readSourceFile"> {
  return {
    sourcePathExists: gitSourcePathExists(repoDir, sha),
    readSourceFile: async (path) => {
      try {
        const object = `${sha}:${path}`
        const header = (await git(repoDir, ["cat-file", "-t", object]))
          .toString()
          .trim()
        if (header !== "blob") return null
        const size = Number(
          (await git(repoDir, ["cat-file", "-s", object])).toString().trim(),
        )
        if (!(size <= MAX_SOURCE_READ_BYTES)) return null
        return (await git(repoDir, ["cat-file", "blob", object])).toString(
          "utf8",
        )
      } catch {
        return null
      }
    },
  }
}

/**
 * Checks paths in the source repository. One `git ls-tree` reads the files
 * and folders at `sha` once; each check is then a set lookup. When the
 * listing is larger than the limit of `runGit`, each check fails with that
 * reason, so the step stops.
 */
function gitSourcePathExists(
  repoDir: string,
  sha: string,
): PatchStepInput["sourcePathExists"] {
  let paths: Promise<Set<string>> | undefined
  return async (path, type) => {
    if (type === "blob") {
      // A blob lookup reads the one tree entry and no content.
      const out = await git(repoDir, [
        "--literal-pathspecs",
        "ls-tree",
        "-z",
        sha,
        "--",
        path,
      ]).catch((error: unknown) => {
        if (error instanceof GitOutputTooLargeError) throw error
        return Buffer.alloc(0)
      })
      return out
        .toString("utf8")
        .split("\0")
        .some(
          (r) =>
            r.split("\t")[0]?.split(" ")[1] === "blob" &&
            r.slice(r.indexOf("\t") + 1) === path,
        )
    }
    paths ??= git(repoDir, ["ls-tree", "-r", "-t", "-z", "--name-only", sha])
      .then((out) => new Set(out.toString("utf8").split("\0")))
      .catch((error: unknown) => {
        if (error instanceof GitOutputTooLargeError) throw error
        return new Set<string>()
      })
    return (await paths).has(path.replace(/\/+$/, ""))
  }
}

type StagedOp = {
  op: AcceptedOp["op"]
  path: string
  content?: Buffer
}

type Candidate = {
  op: AcceptedOp["op"]
  path: string
  /** Final file text for create and update. */
  output?: string
  /** The text that the model wrote, for the scan of the whole step. */
  written?: { yaml: string; body: string }
  /** Links to check against the result tree. */
  links: string[]
  claimTargets: string[]
}

export async function validatePatchStep(
  input: PatchStepInput,
): Promise<PatchStepResult> {
  const rejections: PatchRejection[] = []
  const reject = (path: string, rule: PatchRule, reason: string) => {
    rejections.push({ path, rule, reason })
  }
  const sourceUrl = normalizeSourceUrl(input.source.url)
  const sourcePath = sourceIdentity(input.sourcePath)

  const rootPath = input.rootPath ?? ""
  const baseEntries = await listTree(input.repoDir, input.baseCommit, rootPath)
  const patch = await readPatchJson(input.stagedDir, reject)
  const meta = patch.ops
  const rejectedBeforeOps = rejections.length
  const staged = await readStagedFiles(input.stagedDir, reject)
  const stagedRejections = rejections.length - rejectedBeforeOps
  const knownRepositories = new Set(
    [sourceUrl, ...(input.linkableRepositories ?? [])]
      .map((url) => repositoryKey(normalizeSourceUrl(url)))
      .filter((key): key is string => key !== null),
  )

  const stagedPaths = new Set(staged.map((f) => f.path))
  const ops: StagedOp[] = []
  const updated = staged.filter((file) => baseEntries.has(file.path))
  const updatedIds = await hashBlobs(
    input.repoDir,
    updated.map((file) => file.content),
    { write: false },
  )
  const unchanged = new Set(
    updated
      .filter((file, i) => updatedIds[i] === baseEntries.get(file.path))
      .map((file) => file.path),
  )
  for (const file of staged) {
    const base = baseEntries.get(file.path)
    if (unchanged.has(file.path)) continue
    ops.push({
      op: base ? "update" : "create",
      path: file.path,
      content: file.content,
    })
  }
  for (const entry of meta.values()) {
    if (entry.op !== "delete") continue
    if (stagedPaths.has(entry.path)) {
      reject(entry.path, "patch_json", "The path is both staged and deleted")
      continue
    }
    ops.push({ op: "delete", path: entry.path })
  }
  ops.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const baseDirectories = parentFolders(baseEntries.keys())
  const foldedBase = new Map(
    [...baseEntries.keys()].map((path) => [foldPath(path), path]),
  )
  const foldedStaged = new Map<string, number>()
  for (const op of ops) {
    if (op.op === "delete") continue
    const key = foldPath(op.path)
    foldedStaged.set(key, (foldedStaged.get(key) ?? 0) + 1)
  }

  const opLimit = Math.max(
    0,
    Math.min(MAX_STEP_OPS, MAX_WORKSPACE_OPS - (input.workspaceOpsBefore ?? 0)),
  )
  const baseBlobs = await readBlobs(
    input.repoDir,
    [...baseEntries]
      .filter(([path]) => disallowedPathReason(path) === null)
      .map(([, blob]) => blob),
  )
  const baseText = (path: string) => {
    const blob = baseEntries.get(path)
    return blob ? baseBlobs.get(blob)?.toString("utf8") : undefined
  }
  const meter = input.meter ?? { work: 0 }
  // Each distinct path is read from git once per step, and the step reads
  // at most MAX_SOURCE_READS files. A file above the limit counts as absent.
  const budget = { reads: 0, bytes: 0, compares: 0, spent: false }
  const cached = <T>(
    cache: Map<string, Promise<T>>,
    absent: T,
    load: (path: string) => Promise<T>,
  ) => {
    return (path: string): Promise<T> => {
      let hit = cache.get(path)
      if (!hit) {
        if (budget.reads >= MAX_SOURCE_READS) {
          budget.spent = true
          return Promise.resolve(absent)
        }
        budget.reads++
        hit = load(path)
        cache.set(path, hit)
      }
      return hit
    }
  }
  // An evidence path is a lookup, not a file read, so it does not use the
  // read budget. Each distinct path is asked once.
  const evidenceCache = new Map<string, Promise<boolean>>()
  const evidenceExists = (path: string) => {
    let hit = evidenceCache.get(path)
    if (!hit) {
      hit = input.sourcePathExists(path)
      evidenceCache.set(path, hit)
    }
    return hit
  }
  const sourceText = cached(
    new Map<string, Promise<string | null>>(),
    null,
    async (path) => {
      // The reads of one step may not download more than the total limit.
      if (budget.bytes >= MAX_SOURCE_READ_TOTAL_BYTES) {
        budget.spent = true
        return null
      }
      const text = await input.readSourceFile(path)
      if (text !== null) budget.bytes += Buffer.byteLength(text)
      return text
    },
  )
  // The quote check compares with the normalized text, made once per path.
  const quotableCache = new Map<string, Promise<string | null>>()
  const quotableSource = (path: string) => {
    let hit = quotableCache.get(path)
    if (!hit) {
      hit = sourceText(path).then((text) => {
        if (text === null) return null
        meter.work += text.length
        return quotableText(text)
      })
      quotableCache.set(path, hit)
    }
    return hit
  }
  // Each compare reads the source text once, so the step makes at most
  // MAX_SOURCE_COMPARES of them.
  const sourceIncludes = async (
    source: Promise<string | null>,
    part: string,
  ): Promise<boolean | "spent"> => {
    if (budget.compares >= MAX_SOURCE_COMPARES) {
      budget.spent = true
      return "spent"
    }
    budget.compares++
    const text = await source
    if (text === null) return false
    meter.work += text.length + part.length
    return text.includes(part)
  }
  const context: CheckContext = {
    sourcePath,
    source: input.source,
    skill: input.skill,
    bundle: input.bundle,
    root: input.root,
    meter,
    evidenceExists,
    // The lookup reads no content, so it uses no read or byte budget.
    sourceFileExists: (path) => input.sourcePathExists(path, "blob"),
    quoteInSource: (path, quote) =>
      sourceIncludes(quotableSource(path), quotableText(quote)),
    patternInSource: (path, pattern) =>
      sourceIncludes(sourceText(path), pattern),
  }

  let candidates: Candidate[] = []
  for (const [index, op] of ops.entries()) {
    if (index >= opLimit) {
      reject(
        op.path,
        "op_cap",
        `A step writes at most ${MAX_STEP_OPS} ops and a Workspace at most ${MAX_WORKSPACE_OPS} in a run`,
      )
      continue
    }
    if (findSuspectedSecret(op.path.replaceAll("/", "\n"))) {
      reject(
        op.path,
        "suspected_secret",
        "The path has a value that looks like a secret",
      )
      continue
    }
    const pathReason = disallowedPathReason(op.path)
    if (pathReason) {
      reject(op.path, "path", pathReason)
      continue
    }
    const conflict =
      op.op === "create"
        ? treeConflict(
            op.path,
            baseEntries,
            baseDirectories,
            foldedBase,
            foldedStaged,
          )
        : null
    if (conflict) {
      reject(op.path, "path", conflict)
      continue
    }
    const baseBlob = baseEntries.get(op.path)
    const declared = meta.get(op.path)
    if (op.op !== "create") {
      if (!baseBlob || declared?.baseBlob !== baseBlob) {
        reject(
          op.path,
          "base_blob_mismatch",
          "The baseBlob does not match the file at the base commit",
        )
        continue
      }
    } else if (declared?.baseBlob) {
      reject(
        op.path,
        "base_blob_mismatch",
        "The file does not exist at the base commit",
      )
      continue
    }
    if (context.root !== undefined && SHARED_FOLDER.test(op.path)) {
      reject(
        op.path,
        "shared_file",
        "More than one root can write this file, so only a repository-wide step writes it",
      )
      continue
    }
    const before = baseText(op.path)
    if (op.op === "delete") {
      if (fileOwnership(before ?? "", sourcePath) !== "sole") {
        reject(
          op.path,
          "ownership",
          "Only a file that the source alone owns can be deleted",
        )
        continue
      }
      if (humanBlocks(before ?? "").length > 0) {
        reject(
          op.path,
          "human_section",
          "A file with a human section can not be deleted",
        )
        continue
      }
      candidates.push({
        op: "delete",
        path: op.path,
        links: [],
        claimTargets: [],
      })
      continue
    }
    budget.spent = false
    const checked = await checkWrite(op, before, context)
    if ("rule" in checked)
      reject(
        op.path,
        checked.rule,
        budget.spent
          ? `${checked.reason}. The step reads at most ${MAX_SOURCE_READS} source files (${MAX_SOURCE_READ_TOTAL_BYTES / 1024 / 1024} MiB in all) and compares at most ${MAX_SOURCE_COMPARES} quotes or patterns with them`
          : checked.reason,
      )
    else candidates.push(checked)
  }
  // A value can be cut over files. The scan reads the bodies and then the
  // front matter of all written files, each in path order and without the
  // blank lines at its ends, as one text. A finding in that text rejects
  // every written file of the step: a search for the smallest run of files
  // with the finding can accept files that hold a part of a second value.
  const written = candidates.flatMap((c) => (c.written ? [c] : []))
  const joined = [
    ...written.map((c) => c.written?.body.trim() ?? ""),
    ...written.map((c) => c.written?.yaml.trim() ?? ""),
  ].join("\n")
  if (written.length > 0 && findSuspectedSecret(joined, meter) !== null)
    for (const c of written)
      reject(
        c.path,
        "suspected_secret",
        "The text that the step writes, read as one text, has a value that looks like a secret",
      )
  candidates = candidates.filter(
    (c) => !rejections.some((r) => r.path === c.path),
  )

  const deletes = candidates.filter((c) => c.op === "delete")
  const ownedCount = [...baseEntries.keys()].filter(
    (path) =>
      disallowedPathReason(path) === null &&
      fileOwnership(baseText(path) ?? "", sourcePath) === "sole",
  ).length
  const deleteLimit = Math.floor(ownedCount * MAX_DELETE_SHARE)
  let accepted = candidates
  if (!input.rootGone && deletes.length > deleteLimit) {
    for (const op of deletes)
      reject(
        op.path,
        "delete_cap",
        `The step deletes ${deletes.length} of ${ownedCount} owned files; the limit is ${deleteLimit}`,
      )
    accepted = candidates.filter((c) => c.op !== "delete")
  }

  // Links resolve against the result tree, so repeat until no op drops out.
  for (;;) {
    const present = new Set(baseEntries.keys())
    for (const op of accepted) {
      if (op.op === "delete") present.delete(op.path)
      else present.add(op.path)
    }
    const directories = parentFolders(present)
    const failed = new Map<Candidate, string>()
    for (const op of accepted) {
      const reason = linkProblem(op, present, directories, knownRepositories)
      if (reason) failed.set(op, reason)
    }
    if (failed.size === 0) break
    for (const [op, reason] of failed) reject(op.path, "link", reason)
    accepted = accepted.filter((op) => !failed.has(op))
  }

  const tree = await applyOps(
    input.repoDir,
    input.baseCommit,
    accepted,
    rootPath,
  )
  const acceptedPaths = new Set(accepted.map((op) => op.path))
  const result = await listTree(input.repoDir, tree, rootPath)
  for (const path of new Set([...result.keys(), ...baseEntries.keys()])) {
    if (result.get(path) !== baseEntries.get(path) && !acceptedPaths.has(path))
      throw new Error(
        "The result tree changes a path that no accepted op names",
      )
  }
  // A rejection never shows a path that holds a secret.
  for (const rejection of rejections)
    if (findSuspectedSecret(rejection.path.replaceAll("/", "\n")))
      rejection.path = "[a path that looks like a secret]"
  const opRejections = rejections.filter((r) => r.rule !== "patch_json").length
  const total = ops.length + stagedRejections
  return {
    tree,
    accepted: accepted.map(({ op, path }) => ({ op, path })),
    rejections,
    status: total > 0 && opRejections * 2 > total ? "partial" : "complete",
    more: patch.more,
  }
}

type CheckContext = {
  /** The path of the run's source file in this Workspace (`sources`). */
  sourcePath: string
  source: { url: string; sha: string }
  skill: string
  bundle: string
  root: string | undefined
  meter: WorkMeter
  evidenceExists: (path: string) => Promise<boolean>
  /** True when the path is a file (a blob) of the source. */
  sourceFileExists: (path: string) => Promise<boolean>
  /** True when the quote, whitespace normalized, is text of the source file. */
  quoteInSource: (path: string, quote: string) => Promise<boolean | "spent">
  /** True when the source file holds the pattern of an inferred rule. */
  patternInSource: (path: string, pattern: string) => Promise<boolean | "spent">
}

type CheckFailure = { rule: PatchRule; reason: string }

async function checkWrite(
  op: StagedOp,
  before: string | undefined,
  context: CheckContext,
): Promise<Candidate | CheckFailure> {
  const bytes = op.content ?? Buffer.alloc(0)
  if (bytes.length > MAX_FILE_BYTES)
    return {
      rule: "size_cap",
      reason: `The file is larger than ${MAX_FILE_BYTES} bytes`,
    }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return { rule: "content", reason: "The file is not valid UTF-8" }
  }
  const ownership =
    op.op === "create"
      ? "sole"
      : fileOwnership(before ?? "", context.sourcePath)
  // A generated area file is shared: its own rules (area-file.ts) apply to
  // each source, also to one that the file does not list yet.
  if (op.path.startsWith("knowledge/instructions/") && !AREA_PATH.test(op.path))
    return {
      rule: "path",
      reason:
        "An area file is knowledge/instructions/<slug>.md with a lower-case slug",
    }
  const areaFile =
    AREA_PATH.test(op.path) &&
    (op.op === "create" || generatedByHost(before ?? ""))
  const result = areaFile
    ? await checkAreaWrite(op, text, before, context)
    : ownership === "sole"
      ? await checkFullWrite(op, text, before, context)
      : await checkAdditiveWrite(text, before ?? "", context)
  if ("rule" in result) return result
  // The scan reads the text that is stored: YAML escapes in the staged
  // front matter are decoded by then. An additive write scans its own part.
  let written = { yaml: "", body: result.added ?? "" }
  if (areaFile || ownership === "sole") {
    const secret = secretProblem(result.output, context.meter)
    if (secret) return secret
    written = splitFrontMatter(result.output) ?? written
  }
  if (Buffer.byteLength(result.output) > MAX_FILE_BYTES)
    return {
      rule: "size_cap",
      reason: `The file is larger than ${MAX_FILE_BYTES} bytes`,
    }
  const { added: _added, ...rest } = result
  return { op: op.op, path: op.path, ...rest, written }
}

type WriteOutput = {
  output: string
  links: string[]
  claimTargets: string[]
  /** The text that an additive write adds. */
  added?: string
}

export const AREA_PATH =
  /^knowledge\/instructions\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/

function generatedByHost(raw: string): boolean {
  const front = splitFrontMatter(raw)
  return (
    (front ? parseYamlObject(front.yaml) : null)?.generated_by === GENERATED_BY
  )
}

/** A new area file, or an update of a generated one (concept section 5.3). */
async function checkAreaWrite(
  op: StagedOp,
  text: string,
  before: string | undefined,
  context: CheckContext,
): Promise<WriteOutput | CheckFailure> {
  const shared = (reason: string): CheckFailure => ({
    rule: "shared_file",
    reason,
  })
  const front = splitFrontMatter(text)
  if (!front)
    return { rule: "front_matter", reason: "The file has no front matter" }
  const raw = parseYamlObject(front.yaml)
  if (!raw)
    return {
      rule: "front_matter",
      reason: "The front matter is not a YAML map",
    }
  const parsed = FrontMatterSchema.safeParse(raw)
  if (!parsed.success)
    return { rule: "front_matter", reason: zodReason(parsed.error) }
  const attributes = parsed.data
  if (attributes.kind !== "InstructionUnit")
    return {
      rule: "front_matter",
      reason: "The kind for knowledge/instructions/ is InstructionUnit",
    }
  const baseFront = before ? splitFrontMatter(before) : null
  const baseAttributes = baseFront
    ? (parseYamlObject(baseFront.yaml) ?? {})
    : {}
  for (const field of HOST_FIELDS) {
    if (!(field in raw)) continue
    if (
      op.op === "create" ||
      !isDeepStrictEqual(raw[field], baseAttributes[field])
    )
      return { rule: "front_matter", reason: `Only the host sets ${field}` }
  }
  if (!isDeepStrictEqual(raw.claims, baseAttributes.claims))
    return { rule: "front_matter", reason: "An area file has no claims" }

  const human = humanSectionProblem(front, before)
  if (human) return human
  const content = contentProblem(text)
  if (content) return content
  // The script writes human sections at the end of an area file. A human
  // section that moves into a rule or the summary would change what its
  // text means, so it must stay there.
  const firstHuman = text.indexOf(HUMAN_OPEN)
  if (
    firstHuman !== -1 &&
    text.slice(firstHuman).replace(HUMAN_BLOCK, "").trim() !== ""
  )
    return {
      rule: "human_section",
      reason: "A human section of an area file stays at the end of the file",
    }
  // A human section is the same as at the base, so the heading and
  // injection rules read only the text that the model wrote.
  const heading = deniedHeading(withoutHumanText(front.body, context.meter))
  if (heading) return heading
  // An area file has no place for a quote, so the scan reads all of its
  // text: code spans, fenced blocks, and block quotes too.
  const injection = injectionProblem(withoutHumanText(text, context.meter), {
    everywhere: true,
  })
  if (injection) return injection

  const beforeSources = fileSources(before ?? "")
  const others = beforeSources.filter((s) => s !== context.sourcePath)
  if (others.length > 0 && attributes.name !== baseAttributes.name)
    return shared("Only the source that owns the file alone can rename it")
  if (others.length > 0 && attributes.summary !== baseAttributes.summary)
    return shared(
      "Only the source that owns the file alone can change the summary",
    )

  const withoutHuman = (body: string) => body.replace(HUMAN_BLOCK, "")
  const after = parseAreaBody(withoutHuman(front.body))
  if ("error" in after) return shared(after.error)
  let beforeArea: AreaFile | null = null
  if (before && baseFront) {
    const read = parseAreaBody(withoutHuman(baseFront.body))
    beforeArea = "error" in read ? null : read
  }
  const change = checkAreaChange({
    before: beforeArea,
    after,
    source: context.sourcePath,
    beforeSources,
  })
  if ("error" in change) return shared(change.error)
  for (const path of change.freshEvidence)
    if (!(await context.evidenceExists(path)))
      return {
        rule: "evidence",
        reason: "An evidence path does not exist at the source revision",
      }
  for (const { pattern, paths } of change.freshPatterns)
    for (const path of paths)
      if ((await context.patternInSource(path, pattern)) !== true)
        return {
          rule: "evidence",
          reason:
            "An evidence file of an inferred rule does not hold the rule's pattern at the source revision",
        }

  const stamped = {
    kind: attributes.kind,
    name: attributes.name,
    ...(attributes.summary === undefined
      ? {}
      : { summary: attributes.summary }),
    generated_by: GENERATED_BY,
    sources: change.sources,
    source_sha: context.source.sha,
    skill: context.skill,
    bundle: context.bundle,
  }
  const known = new Set((before ?? "").split("\n"))
  const addedLines = front.body.split("\n").filter((line) => !known.has(line))
  return {
    output: `---\n${stringify(stamped)}---\n${front.body}`,
    links: markdownLinks(addedLines.join("\n")),
    claimTargets: [],
  }
}

/** A new file, or a file that only this source owns. */
async function checkFullWrite(
  op: StagedOp,
  text: string,
  before: string | undefined,
  context: CheckContext,
): Promise<WriteOutput | CheckFailure> {
  const front = splitFrontMatter(text)
  if (!front)
    return { rule: "front_matter", reason: "The file has no front matter" }
  const raw = parseYamlObject(front.yaml)
  if (!raw)
    return {
      rule: "front_matter",
      reason: "The front matter is not a YAML map",
    }
  const parsed = FrontMatterSchema.safeParse(raw)
  if (!parsed.success)
    return { rule: "front_matter", reason: zodReason(parsed.error) }
  const attributes = parsed.data
  const folder = op.path.split("/")[1] ?? ""
  const kind = FOLDER_KINDS.get(folder)
  if (attributes.kind !== kind)
    return {
      rule: "front_matter",
      reason: `The kind for knowledge/${folder}/ is ${kind}`,
    }

  const baseFront = before ? splitFrontMatter(before) : null
  const baseAttributes = baseFront
    ? (parseYamlObject(baseFront.yaml) ?? {})
    : {}
  for (const field of HOST_FIELDS) {
    if (!(field in raw)) continue
    if (
      op.op === "create" ||
      !isDeepStrictEqual(raw[field], baseAttributes[field])
    )
      return { rule: "front_matter", reason: `Only the host sets ${field}` }
  }

  if (attributes.kind !== "Workflow" && attributes.workflow_file !== undefined)
    return {
      rule: "front_matter",
      reason: "Only a Workflow file has workflow_file",
    }
  // A GitHub Actions workflow file of the source: GitHub runs only the
  // files directly in `.github/workflows/`. It must be a file, not a
  // folder. Hydrate joins a merged pull request that changes it to the
  // Workflow file (`PullRequest CHANGED Workflow`).
  if (
    attributes.kind === "Workflow" &&
    !(
      WORKFLOW_FILE_PATTERN.test(attributes.workflow_file ?? "") &&
      (await context.sourceFileExists(attributes.workflow_file ?? ""))
    )
  )
    return {
      rule: "front_matter",
      reason: "workflow_file must name a workflow file of the source",
    }

  const human = humanSectionProblem(front, before)
  if (human) return human

  const content = contentProblem(text)
  if (content) return content
  // A human section is the same as at the base, so the heading, injection,
  // and quote rules read only the text that the model wrote.
  const body = withoutHumanText(front.body, context.meter)
  const heading = deniedHeading(body)
  if (heading) return heading
  const injection =
    injectionProblem(front.yaml, { everywhere: true }) ?? injectionProblem(body)
  if (injection) return injection
  const quote = await unsourcedQuoteProblem(body, context)
  if (quote) return quote

  const claims = attributes.claims ?? []
  const baseClaims: unknown[] = Array.isArray(baseAttributes.claims)
    ? baseAttributes.claims
    : []
  // A claim that is in the base stays as the base has it, with its
  // confidence. A closed legacy claim is history: it stays also when the
  // step leaves it out.
  const kept = (claim: unknown) =>
    baseClaims.find((b) =>
      isDeepStrictEqual(withoutConfidence(b), withoutConfidence(claim)),
    )
  // A step cannot replace, rewrite, or re-label a legacy claim: a new claim
  // with the target and predicate of a base legacy claim is refused.
  const legacyKeys = new Set(
    baseClaims.filter(isLegacyClaim).map((b) => claimKey(b)),
  )
  const fresh: Claim[] = []
  for (const claim of claims) {
    if (kept(claim)) continue
    if (isLegacyClaim(claim) || legacyKeys.has(claimKey(claim)))
      return {
        rule: "front_matter",
        reason: "Only the host sets or changes a legacy claim",
      }
    fresh.push(claim as Claim)
  }
  const evidence = await evidenceProblem(fresh, context)
  if (evidence) return evidence
  const outClaims = [
    ...claims.map((claim) => kept(claim) ?? stampClaim(claim as Claim)),
    ...baseClaims.filter(
      (b) =>
        isLegacyClaim(b) &&
        (b as { valid_to?: unknown }).valid_to != null &&
        !claims.some((claim) =>
          isDeepStrictEqual(withoutConfidence(b), withoutConfidence(claim)),
        ),
    ),
  ]

  const baseRoot =
    typeof baseAttributes.root === "string" ? baseAttributes.root : undefined
  // A Repository unit is the whole repository: its root is always `.`.
  const root =
    attributes.kind === "Repository"
      ? "."
      : PACKAGE_KINDS.has(attributes.kind)
        ? (context.root ?? baseRoot)
        : undefined
  const stamped = {
    kind: attributes.kind,
    name: attributes.name,
    ...(attributes.summary === undefined
      ? {}
      : { summary: attributes.summary }),
    ...(attributes.workflow_file === undefined
      ? {}
      : { workflow_file: attributes.workflow_file }),
    ...(outClaims.length ? { claims: outClaims } : {}),
    generated_by: GENERATED_BY,
    sources: [context.sourcePath],
    ...(root === undefined ? {} : { root }),
    source_sha: context.source.sha,
    skill: context.skill,
    bundle: context.bundle,
  }
  return {
    output: `---\n${stringify(stamped, { lineWidth: 0 })}---\n${front.body}`,
    links: markdownLinks(front.body),
    // A legacy claim can name a file that is gone: it records history.
    claimTargets: claims.filter((c) => !isLegacyClaim(c)).map((c) => c.to),
  }
}

/** A human file or a file of another source: new claims and Related lines only. */
async function checkAdditiveWrite(
  text: string,
  before: string,
  context: CheckContext,
): Promise<WriteOutput | CheckFailure> {
  const baseFront = splitFrontMatter(before) ?? { yaml: "", body: before }
  const newFront = splitFrontMatter(text) ?? { yaml: "", body: text }
  const baseAttributes = parseYamlObject(baseFront.yaml)
  const newAttributes = parseYamlObject(newFront.yaml)
  if (!baseAttributes || !newAttributes)
    return {
      rule: "front_matter",
      reason: "The front matter is not a YAML map",
    }
  const additive = (reason: string): CheckFailure => ({
    rule: "additive_only",
    reason,
  })

  const keys = new Set([
    ...Object.keys(baseAttributes),
    ...Object.keys(newAttributes),
  ])
  for (const key of keys) {
    if (key === "claims") continue
    if (!isDeepStrictEqual(baseAttributes[key], newAttributes[key]))
      return additive(
        "Only claims can change in a file that the source does not own alone",
      )
  }
  const baseClaims = baseAttributes.claims ?? []
  const newClaims = newAttributes.claims ?? []
  if (!Array.isArray(baseClaims) || !Array.isArray(newClaims))
    return { rule: "front_matter", reason: "claims must be a list" }
  if (
    newClaims.length < baseClaims.length ||
    !baseClaims.every((claim, i) => isDeepStrictEqual(claim, newClaims[i]))
  )
    return additive("Existing claims must stay unchanged")
  const added: Claim[] = []
  for (const claim of newClaims.slice(baseClaims.length)) {
    const parsed = ClaimSchema.safeParse(claim)
    if (!parsed.success)
      return { rule: "front_matter", reason: zodReason(parsed.error) }
    added.push(parsed.data)
  }

  const related = addedRelatedLines(baseFront.body, newFront.body)
  if (related === null)
    return additive(
      "Only new lines in a Related section at the end are allowed",
    )

  const addedText = [related, ...added.map((c) => JSON.stringify(c))].join("\n")
  if (markerCount(addedText) > 0)
    return {
      rule: "human_section",
      reason: "Only a human can add a human section",
    }
  const content = contentProblem(addedText)
  if (content) return content
  // A Related line has no place for a Source line, so the scan reads the
  // text of its code spans too.
  const injection = injectionProblem(addedText, { inlineCode: true })
  if (injection) return injection
  // The lines before the added text are read too, so that a value cut
  // between them is found. A value in the old lines alone is not ours.
  const kept = baseFront.body.trimEnd().split("\n").slice(-3).join("\n")
  const secret =
    secretProblem(addedText, context.meter, "of the added text ") ??
    (findSuspectedSecret(kept, context.meter)
      ? null
      : secretProblem(
          `${kept}\n${addedText}`,
          context.meter,
          "of the added text and the lines before it, ",
        ))
  if (secret) return secret
  const evidence = await evidenceProblem(added, context)
  if (evidence) return evidence

  let header = before.slice(0, before.length - baseFront.body.length)
  if (added.length) {
    const document = parseDocument(baseFront.yaml)
    if (!document.has("claims")) document.set("claims", document.createNode([]))
    const seq = document.get("claims", true) as YAMLSeq
    for (const claim of added) seq.add(document.createNode(stampClaim(claim)))
    header = `---\n${document.toString({ lineWidth: 0 })}---\n`
  }
  return {
    output: `${header}${newFront.body}`,
    links: markdownLinks(related),
    claimTargets: added.map((c) => c.to),
    added: addedText,
  }
}

function stampClaim(claim: Claim) {
  return {
    to: claim.to,
    predicate: claim.predicate,
    evidence: { path: claim.evidence.path, kind: claim.evidence.kind },
    confidence: CONFIDENCE[claim.evidence.kind],
  }
}

/** The target and predicate of a claim. */
function claimKey(claim: unknown): string {
  const { to, predicate } = (claim ?? {}) as Record<string, unknown>
  return JSON.stringify([to, predicate])
}

function withoutConfidence(claim: unknown): unknown {
  if (!claim || typeof claim !== "object") return claim
  const { confidence: _confidence, ...rest } = claim as Record<string, unknown>
  return rest
}

async function evidenceProblem(
  claims: readonly Claim[],
  context: CheckContext,
): Promise<CheckFailure | null> {
  for (const claim of claims) {
    if (!(await context.evidenceExists(claim.evidence.path)))
      return {
        rule: "evidence",
        reason: "An evidence path does not exist at the source revision",
      }
  }
  return null
}

/**
 * The lines that `next` adds to a `## Related` section at the end of `base`,
 * or null when the body changes in another way.
 */
function addedRelatedLines(base: string, next: string): string | null {
  const kept = base.trimEnd()
  if (!next.startsWith(kept)) return null
  const rest = next.slice(kept.length)
  if (rest.trim() === "") return ""
  const headings = [...kept.matchAll(/^ {0,3}(#{1,6})[ \t]+(.*)$/gm)]
  const last = headings.at(-1)
  const endsInRelated =
    last?.[1] === "##" && /^related[ \t#]*$/i.test(last[2]?.trim() ?? "")
  let lines: string
  if (endsInRelated) {
    if (!rest.startsWith("\n")) return null
    lines = rest
  } else {
    const section = /^\n+## Related[ \t]*\n/.exec(rest)
    if (!section) return null
    lines = rest.slice(section[0].length)
  }
  for (const line of lines.split("\n")) {
    if (line.trim() === "") continue
    if (!/^[-*] \S/.test(line)) return null
  }
  return lines.trim()
}

const HUMAN_BLOCK = new RegExp(
  `${escapeRegExp(HUMAN_OPEN)}[\\s\\S]*?${escapeRegExp(HUMAN_CLOSE)}`,
  "g",
)
const HUMAN_MARKER = new RegExp(
  `${escapeRegExp(HUMAN_OPEN)}|${escapeRegExp(HUMAN_CLOSE)}`,
  "g",
)

/**
 * Each human section of the base stays byte for byte in the body. The
 * host writes new front matter, so a section in the front matter or in a
 * YAML comment would not be in the stored file.
 */
function humanSectionProblem(
  front: { yaml: string; body: string },
  before: string | undefined,
): CheckFailure | null {
  if (
    markerCount(front.yaml) > 0 ||
    !isDeepStrictEqual(humanBlocks(front.body), humanBlocks(before ?? "")) ||
    markerCount(front.body) !== markerCount(before ?? "")
  )
    return {
      rule: "human_section",
      reason: "The human section must not change",
    }
  return null
}

/**
 * True when `after` has front matter and keeps each human section of
 * `before` byte for byte in its body (the check of a staged write). A host
 * edit outside a patch step uses it.
 */
export function humanSectionsKept(before: string, after: string): boolean {
  const front = splitFrontMatter(after)
  return front !== null && humanSectionProblem(front, before) === null
}

export function humanBlocks(text: string): string[] {
  return [...text.matchAll(HUMAN_BLOCK)].map((m) => m[0])
}

function markerCount(text: string): number {
  return [...text.matchAll(HUMAN_MARKER)].length
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function contentProblem(text: string): CheckFailure | null {
  const fail = (reason: string): CheckFailure => ({ rule: "content", reason })
  if (text.includes("\u0000")) return fail("The file has a NUL character")
  if (/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(text))
    return fail("The file has a bidirectional control character")
  if (/[\u200B-\u200D\u2060\uFEFF]/.test(text))
    return fail("The file has a zero-width character")
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the check finds control characters
  if (/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text))
    return fail("The file has a control character")
  const tokens = [...text.matchAll(HUMAN_MARKER)].map((m) =>
    m[0] === HUMAN_OPEN ? "" : "/",
  )
  if (
    tokens.some((t, i) => t !== (i % 2 === 0 ? "" : "/")) ||
    tokens.length % 2
  )
    return fail("The human-section markers are not in pairs")
  const prose = withoutCode(text, false)
    .split(HUMAN_OPEN)
    .join("")
    .split(HUMAN_CLOSE)
    .join("")
  if (prose.includes("<!--")) return fail("HTML comments are not allowed")
  if (/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>|<[!?][a-z]/i.test(prose))
    return fail("Raw HTML is not allowed")
  return null
}

function deniedHeading(body: string): CheckFailure | null {
  for (const heading of markdownHeadings(body)) {
    if (DENIED_HEADINGS.some((pattern) => pattern.test(heading)))
      return {
        rule: "heading_denylist",
        reason: "A heading addresses agents or models",
      }
  }
  return null
}

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] }

/** Every heading, also setext headings and headings in lists and block quotes. */
function markdownHeadings(body: string): string[] {
  const headings: string[] = []
  const plain = (node: MarkdownNode): string =>
    node.value ?? (node.children ?? []).map(plain).join("")
  const visit = (node: MarkdownNode) => {
    if (node.type === "heading") headings.push(plain(node).trim())
    for (const child of node.children ?? []) visit(child)
  }
  visit(fromMarkdown(body) as MarkdownNode)
  return headings
}

/**
 * Scans text outside fenced code, block quotes, and inline code (concept
 * section 6). `inlineCode` scans the text of code spans too, and
 * `everywhere` scans all of the text.
 */
function injectionProblem(
  text: string,
  options: { everywhere?: boolean; inlineCode?: boolean } = {},
): CheckFailure | null {
  const outside = (
    options.everywhere
      ? text
      : withoutCode(text, options.inlineCode ?? false)
          .split("\n")
          .filter((line) => !/^ {0,3}>/.test(line))
          .join("\n")
  ).replace(/\s+/g, " ")
  if (hasInstruction(outside))
    return {
      rule: "suspected_injection",
      reason: "The text looks like an instruction to an agent",
    }
  return null
}

function hasInstruction(text: string): boolean {
  return INJECTION_PHRASES.some((pattern) => pattern.test(text))
}

/**
 * A block quote, fenced block, or inline code that holds an injection
 * phrase must give its source with a `Source: <path>` line, as its last
 * line or as the next line after it. Each quoted text, with whitespace
 * normalized, must occur in that file at the source revision (ADR-052
 * section 5). Without it, a model can carry an instruction into a file as
 * a quote.
 */
async function unsourcedQuoteProblem(
  body: string,
  context: CheckContext,
): Promise<CheckFailure | null> {
  const fail = (reason: string): CheckFailure => ({
    rule: "suspected_injection",
    reason,
  })
  const blocks = quotedBlocks(body)
  for (const block of blocks) {
    if (!block.quoted || !hasInstruction(block.text)) continue
    if (!block.source) return fail("Quoted instruction text has no Source line")
    for (const quote of block.quotes)
      if ((await context.quoteInSource(block.source, quote)) !== true)
        return fail(
          "The quoted text is not in its Source file at the source revision",
        )
  }
  // A phrase can be cut over a paragraph break or between block quotes.
  // Each block that such a phrase spans must be a true quote of its Source
  // file.
  for (const spanned of spannedInstructions(blocks))
    for (const block of spanned) {
      if (!block.source)
        return fail("Instruction text over more blocks has no Source line")
      if ((await context.quoteInSource(block.source, block.whole)) !== true)
        return fail(
          "Instruction text over more blocks is not in its Source file at the source revision",
        )
    }
  return null
}

/**
 * The runs of adjacent blocks, two or more, whose text read as one text
 * has an injection phrase that no shorter run has. One phrase in a block
 * does not hide a different phrase over that block and the next. Only the last and first
 * 200 characters of the end blocks are read, and the blocks between them
 * have at most 200 characters, because a phrase is shorter than that.
 */
function spannedInstructions(blocks: QuotedBlock[]): QuotedBlock[][] {
  const edge = 200
  const window = (from: number, to: number, single: "head" | "tail") =>
    blocks
      .slice(from, to + 1)
      .map((block, offset) => {
        const at = from + offset
        const head = from === to ? single === "head" : at === to
        const tail = from === to ? single === "tail" : at === from
        if (tail) return block.text.slice(-edge)
        if (head) return block.text.slice(0, edge)
        return block.text
      })
      .join(" ")
  const runs: QuotedBlock[][] = []
  for (let from = 0; from < blocks.length; from++) {
    let between = 0
    for (let to = from + 1; to < blocks.length && between <= edge; to++) {
      const run = window(from, to, "tail")
      const left = window(from, to - 1, "tail")
      const right = window(from + 1, to, "head")
      if (
        INJECTION_PHRASES.some(
          (phrase) =>
            phrase.test(run) && !phrase.test(left) && !phrase.test(right),
        )
      )
        runs.push(blocks.slice(from, to + 1))
      between += (blocks[to]?.text.length ?? 0) + 1
    }
  }
  return runs
}

/** Text with block-quote markers removed and whitespace normalized, to compare a quote with its source. */
function quotableText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^[ \t]*(?:>[ \t]?)*/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

const SOURCE_LINE = /^\s*Source:\s*`?([^`\s]+)`?\s*$/

type QuotedBlock = {
  /** The text that the injection phrases are tested on. */
  text: string
  /** The parts that must be text of the Source file. */
  quotes: string[]
  /** The text that must be in the Source file when a phrase spans blocks. */
  whole: string
  /** False for a paragraph without inline code. */
  quoted: boolean
  source: string | null
}

/**
 * Block quotes, fenced blocks, and paragraphs, in body order, each with
 * the path of its Source line. A paragraph that is only a Source line is
 * not a block. For a paragraph, the phrases are tested on its text with
 * the code spans in it, so that a phrase cut between prose and code is
 * found; each code span is a quote.
 */
function quotedBlocks(body: string): QuotedBlock[] {
  const lines = body.split("\n")
  const blocks: QuotedBlock[] = []
  const nextLine = (from: number) => {
    let i = from
    while (i < lines.length && (lines[i] ?? "").trim() === "") i++
    return lines[i] ?? ""
  }
  const fenceOf = (line: string) => /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
  const quoteLine = (line: string) => /^ {0,3}>/.test(line)
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    const fence = fenceOf(line)
    const inner: string[] = []
    if (fence) {
      i++
      while (i < lines.length) {
        const current = lines[i] ?? ""
        const marker = fenceOf(current)
        i++
        if (
          marker &&
          marker[0] === fence[0] &&
          marker.length >= fence.length &&
          current.trim() === marker
        )
          break
        inner.push(current)
      }
    } else if (quoteLine(line)) {
      while (i < lines.length && quoteLine(lines[i] ?? "")) {
        inner.push((lines[i] ?? "").replace(/^ {0,3}>+ ?/, ""))
        i++
      }
    } else if (line.trim() !== "") {
      const paragraph: string[] = []
      while (
        i < lines.length &&
        (lines[i] ?? "").trim() !== "" &&
        !fenceOf(lines[i] ?? "") &&
        !quoteLine(lines[i] ?? "")
      )
        paragraph.push(lines[i++] ?? "")
      const inside = SOURCE_LINE.exec(paragraph.at(-1) ?? "")
      if (inside) paragraph.pop()
      if (paragraph.length === 0) continue
      const source = inside?.[1] ?? SOURCE_LINE.exec(nextLine(i))?.[1] ?? null
      if (!paragraph.some((l) => codeSpans(l).length > 0)) {
        const text = paragraph.join(" ").replace(/\s+/g, " ")
        blocks.push({ text, quotes: [], whole: text, quoted: false, source })
        continue
      }
      // A span that holds a phrase alone is a quote. When a phrase is still
      // there without those spans, it is cut between prose and code, so
      // the whole paragraph is the quote. A blank span is never a quote.
      const quoted = paragraph
        .flatMap((l) => codeSpans(l).map((span) => span.text))
        .filter((text) => text.trim() !== "" && hasInstruction(text))
      const rest = withSpans(paragraph, (text) =>
        quoted.includes(text) ? " " : text,
      )
      const text = withSpans(paragraph, (span) => span)
      blocks.push({
        text,
        quotes: hasInstruction(rest) ? [text] : quoted,
        whole: text,
        quoted: true,
        source,
      })
      continue
    } else {
      i++
      continue
    }
    let lastIndex = inner.length - 1
    while (lastIndex >= 0 && inner[lastIndex]?.trim() === "") lastIndex--
    const inside = fence ? undefined : SOURCE_LINE.exec(inner[lastIndex] ?? "")
    const quoted = inside ? inner.slice(0, lastIndex) : inner
    blocks.push({
      text: quoted.join(" ").replace(/\s+/g, " "),
      quotes: [quoted.join("\n")],
      whole: quoted.join("\n"),
      quoted: true,
      source: inside?.[1] ?? SOURCE_LINE.exec(nextLine(i))?.[1] ?? null,
    })
  }
  return blocks
}

/** The lines of a paragraph as one line, with each code span replaced by `span(text)`. */
function withSpans(lines: string[], span: (text: string) => string): string {
  return lines
    .map((line) => {
      let out = ""
      let at = 0
      for (const s of codeSpans(line)) {
        out += line.slice(at, s.start) + span(s.text)
        at = s.end
      }
      return out + line.slice(at)
    })
    .join(" ")
    .replace(/\s+/g, " ")
}

function secretProblem(
  text: string,
  meter: WorkMeter,
  where = "",
): CheckFailure | null {
  const finding = findSuspectedSecret(text, meter)
  if (!finding) return null
  return {
    rule: "suspected_secret",
    reason: finding.reason.replace(" on line", ` on ${where}line`),
  }
}

/**
 * Removes fenced code blocks and inline code spans. With `keepSpanText`, a
 * code span keeps its text and loses only its backticks. Without it, a
 * span becomes one space, so the words at its two sides stay apart.
 */
function withoutCode(text: string, keepSpanText: boolean): string {
  const out: string[] = []
  let fence: string | null = null
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
      )
        fence = null
      out.push("")
      continue
    }
    if (marker) {
      fence = marker
      out.push("")
      continue
    }
    let kept = ""
    let at = 0
    for (const span of codeSpans(line)) {
      kept += line.slice(at, span.start) + (keepSpanText ? span.text : " ")
      at = span.end
    }
    out.push(kept + line.slice(at))
  }
  return out.join("\n")
}

/**
 * The code spans of one line, in linear time: a run of n backticks opens a
 * span that the next run of exactly n backticks closes.
 */
function codeSpans(
  line: string,
): Array<{ start: number; end: number; text: string }> {
  const runs: Array<{ at: number; length: number }> = []
  for (let i = line.indexOf("`"); i !== -1; i = line.indexOf("`", i)) {
    let j = i
    while (line[j] === "`") j++
    runs.push({ at: i, length: j - i })
    i = j
  }
  const next: number[] = []
  const later = new Map<number, number>()
  for (let k = runs.length - 1; k >= 0; k--) {
    const length = runs[k]?.length ?? 0
    next[k] = later.get(length) ?? -1
    later.set(length, k)
  }
  const spans: Array<{ start: number; end: number; text: string }> = []
  for (let k = 0; k < runs.length; ) {
    const open = runs[k]
    const close = runs[next[k] ?? -1]
    if (!open || !close) {
      k++
      continue
    }
    spans.push({
      start: open.at,
      end: close.at + close.length,
      text: line.slice(open.at + open.length, close.at),
    })
    k = (next[k] ?? k) + 1
  }
  return spans
}

function markdownLinks(body: string): string[] {
  const prose = withoutCode(body, false)
  const links: string[] = []
  for (const m of prose.matchAll(
    /\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g,
  ))
    links.push(m[1] ?? "")
  for (const m of prose.matchAll(/^ {0,3}\[[^\]]+\]:[ \t]*<?([^\s>]+)>?/gm))
    links.push(m[1] ?? "")
  for (const m of prose.matchAll(/<([a-z][a-z0-9+.-]*:[^>\s]*)>/gi))
    links.push(m[1] ?? "")
  for (const m of prose.matchAll(
    /(?<![\w.@/:-])www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>()]*/gi,
  ))
    links.push(`http://${m[0].replace(/[.,;:!?]+$/, "")}`)
  for (const m of prose.matchAll(/\b(?:https?|ftp|file):\/\/[^\s<>()\]"'`]+/gi))
    links.push(m[0].replace(/[.,;:!?]+$/, ""))
  for (const m of prose.matchAll(/(?<![\w/:])\/\/[a-z0-9.-]+\.[a-z]{2,}/gi))
    links.push(m[0])
  return links
}

function linkProblem(
  op: Candidate,
  present: ReadonlySet<string>,
  directories: ReadonlySet<string>,
  knownRepositories: ReadonlySet<string>,
): string | null {
  for (const target of op.claimTargets) {
    const resolved = resolveRelative(op.path, target)
    if (!resolved || !present.has(resolved))
      return "A claim target does not resolve to a file"
  }
  for (const link of op.links) {
    if (link === "" || link.startsWith("#")) continue
    if (link.startsWith("//")) return "A link has no scheme"
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) {
      let url: URL
      try {
        url = new URL(link)
      } catch {
        return "A link is not a valid URL"
      }
      if (url.protocol !== "https:" && url.protocol !== "http:")
        return "A link is not an http link"
      const key = repositoryKey(link)
      if (!key || !knownRepositories.has(key))
        return "External links go only to repositories that the Workspace knows"
      continue
    }
    const resolved = resolveRelative(op.path, link)
    if (!resolved || !(present.has(resolved) || directories.has(resolved)))
      return "A relative link does not resolve"
  }
  return null
}

/** `host/owner/repository` in lower case, or null. */
function repositoryKey(url: string): string | null {
  try {
    const parsed = new URL(url)
    const [owner, repository] = parsed.pathname.split("/").filter(Boolean)
    if (!owner || !repository) return null
    return `${parsed.host}/${owner}/${repository.replace(/\.git$/i, "")}`.toLowerCase()
  } catch {
    return null
  }
}

function foldPath(path: string): string {
  return path.normalize("NFC").toLowerCase()
}

function parentFolders(paths: Iterable<string>): Set<string> {
  const folders = new Set<string>()
  for (const path of paths) {
    const parts = path.split("/")
    for (let i = 1; i < parts.length; i++)
      folders.add(parts.slice(0, i).join("/"))
  }
  return folders
}

/** A create must not replace a base file or folder, or collide in case or form. */
function treeConflict(
  path: string,
  baseEntries: ReadonlyMap<string, string>,
  baseFolders: ReadonlySet<string>,
  foldedBase: ReadonlyMap<string, string>,
  foldedStaged: ReadonlyMap<string, number>,
): string | null {
  const parts = path.split("/")
  for (let i = 1; i < parts.length; i++)
    if (baseEntries.has(parts.slice(0, i).join("/")))
      return "A parent of the path is a file at the base commit"
  if (baseFolders.has(path)) return "The path is a folder at the base commit"
  const key = foldPath(path)
  if (foldedBase.has(key) || (foldedStaged.get(key) ?? 0) > 1)
    return "The path differs from another path only in case or Unicode form"
  return null
}

function resolveRelative(from: string, target: string): string | null {
  let path = target.split("#")[0]?.split("?")[0] ?? ""
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  if (path === "") return null
  const joined = path.startsWith("/")
    ? posix.normalize(path.slice(1))
    : posix.normalize(posix.join(posix.dirname(from), path))
  if (joined === ".." || joined.startsWith("../") || joined === ".") return null
  return joined.replace(/\/$/, "")
}

export function normalizeSourceUrl(url: string): string {
  return normalizeWorkspaceRepositoryUrl(url).replace(/\.git$/i, "")
}

/** Gives the field and the issue code only, so no staged text goes into a reason. */
function zodReason(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return "The front matter does not match the schema"
  const at = issue.path.length
    ? `${issue.path.map((p) => String(p).slice(0, 40)).join(".")}: `
    : ""
  return `${at}${issue.code}`
}

async function readPatchJson(
  stagedDir: string,
  reject: (path: string, rule: PatchRule, reason: string) => void,
): Promise<{
  ops: Map<string, z.infer<typeof PatchJsonSchema>["ops"][number]>
  more: boolean
}> {
  const entries = new Map<
    string,
    z.infer<typeof PatchJsonSchema>["ops"][number]
  >()
  const file = join(stagedDir, "patch.json")
  const stat = await lstat(file).catch(() => null)
  if (!stat?.isFile() || stat.size > MAX_PATCH_JSON_BYTES) {
    reject(
      "patch.json",
      "patch_json",
      "patch.json must be a regular file of at most 1 MiB",
    )
    return { ops: entries, more: false }
  }
  const raw = await readFile(file, "utf8")
  let parsed: z.infer<typeof PatchJsonSchema>
  try {
    parsed = PatchJsonSchema.parse(JSON.parse(raw))
  } catch {
    reject("patch.json", "patch_json", "patch.json does not match the schema")
    return { ops: entries, more: false }
  }
  for (const op of parsed.ops) {
    if (entries.has(op.path))
      reject(op.path, "patch_json", "patch.json names the path more than once")
    else entries.set(op.path, op)
  }
  return { ops: entries, more: parsed.more === true }
}

async function readStagedFiles(
  stagedDir: string,
  reject: (path: string, rule: PatchRule, reason: string) => void,
): Promise<Array<{ path: string; content: Buffer }>> {
  const files: Array<{ path: string; content: Buffer }> = []
  const root = join(stagedDir, "files")
  const rootStat = await lstat(root).catch(() => null)
  if (!rootStat) return files
  if (!rootStat.isDirectory()) {
    reject("files", "path", "The files folder must be a real folder")
    return files
  }
  let total = 0
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir)
    entries.sort()
    for (const name of entries) {
      const path = prefix ? `${prefix}/${name}` : name
      const full = join(dir, name)
      const stat = await lstat(full)
      if (stat.isDirectory()) await walk(full, path)
      else if (!stat.isFile())
        reject(path, "path", "Only regular files can be staged")
      else if (stat.size > MAX_FILE_BYTES)
        reject(
          path,
          "size_cap",
          `The file is larger than ${MAX_FILE_BYTES} bytes`,
        )
      else if (total + stat.size > MAX_STAGED_BYTES)
        reject(path, "size_cap", "The staged tree is larger than 2 MiB")
      else {
        total += stat.size
        files.push({ path, content: await readFile(full) })
      }
    }
  }
  await walk(root, "")
  return files
}

/**
 * The blobs of `commit` below `rootPath`, keyed by the path relative to it.
 * Paths outside the root folder are not in the map.
 */
async function listTree(
  repoDir: string,
  commit: string,
  rootPath: string,
): Promise<Map<string, string>> {
  const out = await git(repoDir, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    commit,
    ...(rootPath ? ["--", `${rootPath}/`] : []),
  ])
  const entries = new Map<string, string>()
  for (const record of out.toString("utf8").split("\0")) {
    if (!record) continue
    const tab = record.indexOf("\t")
    const [mode, type, sha] = record.slice(0, tab).split(" ")
    if (type === "blob" && mode !== "120000" && sha)
      entries.set(
        record.slice(tab + 1 + (rootPath ? rootPath.length + 1 : 0)),
        sha,
      )
  }
  return entries
}

/**
 * The blob ids of `contents`, in order, from one git process. A git process
 * for each file made a step of 30 ops start more than 30 processes, which
 * is slow when the host is busy.
 */
async function hashBlobs(
  repoDir: string,
  contents: ReadonlyArray<Buffer | string>,
  options: { write: boolean },
): Promise<string[]> {
  if (contents.length === 0) return []
  const dir = await mkdtemp(join(tmpdir(), "ctxpipe-patch-blobs-"))
  try {
    const paths = await Promise.all(
      contents.map(async (content, i) => {
        const path = join(dir, String(i))
        await writeFile(path, content)
        return path
      }),
    )
    // `--no-filters` hashes the bytes as is, like `--stdin` does.
    const out = await git(
      repoDir,
      [
        "hash-object",
        ...(options.write ? ["-w"] : []),
        "--no-filters",
        "--stdin-paths",
      ],
      { input: `${paths.join("\n")}\n` },
    )
    const ids = out.toString().trim().split("\n")
    if (ids.length !== contents.length)
      throw new Error("git hash-object returned the wrong number of ids")
    return ids
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function readBlobs(
  repoDir: string,
  shas: string[],
): Promise<Map<string, Buffer>> {
  const unique = [...new Set(shas)]
  const blobs = new Map<string, Buffer>()
  if (unique.length === 0) return blobs
  const out = await git(repoDir, ["cat-file", "--batch"], {
    input: `${unique.join("\n")}\n`,
  })
  let offset = 0
  while (offset < out.length) {
    const newline = out.indexOf(0x0a, offset)
    const [sha, , size] = out.subarray(offset, newline).toString().split(" ")
    const length = Number(size)
    blobs.set(sha ?? "", out.subarray(newline + 1, newline + 1 + length))
    offset = newline + 1 + length + 1
  }
  return blobs
}

async function applyOps(
  repoDir: string,
  baseCommit: string,
  ops: readonly Candidate[],
  rootPath: string,
): Promise<string> {
  const prefix = rootPath ? `${rootPath}/` : ""
  const env = {
    GIT_INDEX_FILE: join(
      tmpdir(),
      `ctxpipe-patch-index-${process.pid}-${Math.random().toString(36).slice(2)}`,
    ),
  }
  try {
    await git(repoDir, ["read-tree", baseCommit], { env })
    const written = ops.filter((op) => op.op !== "delete")
    const ids = await hashBlobs(
      repoDir,
      written.map((op) => op.output ?? ""),
      { write: true },
    )
    const idOf = new Map(written.map((op, i) => [op, ids[i]]))
    const lines = ops.map((op) =>
      op.op === "delete"
        ? `0 ${"0".repeat(40)}\t${prefix}${op.path}`
        : `100644 ${idOf.get(op)}\t${prefix}${op.path}`,
    )
    if (lines.length)
      await git(repoDir, ["update-index", "--index-info"], {
        env,
        input: `${lines.join("\n")}\n`,
      })
    return (await git(repoDir, ["write-tree"], { env })).toString().trim()
  } finally {
    await rm(env.GIT_INDEX_FILE, { force: true })
  }
}
