import { lstat, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { fromMarkdown } from "mdast-util-from-markdown"
import {
  parseDocument,
  parse as parseYaml,
  stringify,
  type YAMLSeq,
} from "yaml"
import { z } from "zod"
import { isConnectorMirrorPath } from "../codeIngestion/connectorMirrorPaths.js"
import { KNOWLEDGE_KIND_FOLDERS } from "../workspaces/layout.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import { type AreaFile, checkAreaChange, parseAreaBody } from "./area-file.js"
import { runGit as git } from "./run-git.js"

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

export type PatchRejection = { path: string; rule: PatchRule; reason: string }
export type AcceptedOp = { op: "create" | "update" | "delete"; path: string }

export type PatchStepResult = {
  tree: string
  accepted: AcceptedOp[]
  rejections: PatchRejection[]
  status: "complete" | "partial"
}

export type PatchStepInput = {
  /** Host checkout or bare repository of the Workspace context repository. */
  repoDir: string
  baseCommit: string
  /** Step output directory: `files/<path>` and `patch.json`. */
  stagedDir: string
  source: { url: string; sha: string }
  skill: string
  bundle: string
  /** True when `path` exists in the source repository at `source.sha`. */
  sourcePathExists: (path: string) => Promise<boolean>
  /** Ops that earlier steps of this run already wrote to this Workspace. */
  workspaceOpsBefore?: number
  /** The step's root is gone, so the delete cap does not apply. */
  rootGone?: boolean
  /** Repositories that the Workspace knows (sources and linked repositories). */
  linkableRepositories?: readonly string[]
}

/** The 12 allowlist folders and their kinds. Patterns are not extracted (ADR-052). */
const FOLDER_KINDS: ReadonlyMap<string, string> = new Map(
  Object.entries(KNOWLEDGE_KIND_FOLDERS)
    .filter(([kind]) => kind !== "Pattern")
    .map(([kind, folder]) => [folder, kind]),
)

const GENERATED_BY = "ctxpipe-extract"
const HOST_FIELDS = [
  "generated_by",
  "sources",
  "source_sha",
  "skill",
  "bundle",
] as const
const CONFIDENCE = { script: 0.7, model: 0.5 } as const
const MAX_FILE_BYTES = 64 * 1024
const MAX_STAGED_BYTES = 2 * 1024 * 1024
const MAX_PATCH_JSON_BYTES = 1024 * 1024
const MAX_STEP_OPS = 30
export const MAX_WORKSPACE_OPS = 300
const MAX_DELETE_SHARE = 0.2
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

const FrontMatterSchema = z
  .object({
    kind: z.string(),
    name: z.string().min(1).max(200),
    summary: z.string().max(1000).optional(),
    claims: z.array(ClaimSchema).max(200).optional(),
    generated_by: z.string().optional(),
    sources: z.array(z.string()).optional(),
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
})

/** Ownership of a file at the base commit, from the host-only fields. */
export type FileOwnership = "sole" | "shared" | "foreign"

/** Shared ownership predicate (concept section 4.3). */
export function fileOwnership(raw: string, sourceUrl: string): FileOwnership {
  const front = splitFrontMatter(raw)
  if (!front) return "foreign"
  const attributes = parseYamlObject(front.yaml)
  if (!attributes || attributes.generated_by !== GENERATED_BY) return "foreign"
  const sources = Array.isArray(attributes.sources)
    ? attributes.sources.filter((s): s is string => typeof s === "string")
    : []
  const normalized = sources.map(normalizeSourceUrl)
  if (!normalized.includes(normalizeSourceUrl(sourceUrl))) return "foreign"
  return new Set(normalized).size === 1 ? "sole" : "shared"
}

/** Normalized source URLs a generated file lists; empty for a file ctxpipe does not generate. */
export function fileSources(raw: string): string[] {
  const front = splitFrontMatter(raw)
  const attributes = front ? parseYamlObject(front.yaml) : null
  if (!attributes || attributes.generated_by !== GENERATED_BY) return []
  return Array.isArray(attributes.sources)
    ? attributes.sources
        .filter((s): s is string => typeof s === "string")
        .map(normalizeSourceUrl)
    : []
}

/** Path check of concept section 3.1; returns a reason or null. */
export function disallowedPathReason(path: string): string | null {
  if (!path || path.includes("\\") || path.startsWith("/"))
    return "The path must be a relative POSIX path"
  const segments = path.split("/")
  if (segments.some((s) => s === "" || s === "." || s === ".."))
    return "The path has an empty, '.', or '..' segment"
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

/** Checks paths in the source repository with `git cat-file -e`. */
export function gitSourcePathExists(
  repoDir: string,
  sha: string,
): (path: string) => Promise<boolean> {
  return async (path) => {
    try {
      await git(repoDir, ["cat-file", "-e", `${sha}:${path}`])
      return true
    } catch {
      return false
    }
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

  const baseEntries = await listTree(input.repoDir, input.baseCommit)
  const meta = await readPatchJson(input.stagedDir, reject)
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
  for (const file of staged) {
    const base = baseEntries.get(file.path)
    if (base && (await blobId(input.repoDir, file.content)) === base) continue
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
  const evidenceCache = new Map<string, Promise<boolean>>()
  const evidenceExists = (path: string) => {
    let hit = evidenceCache.get(path)
    if (!hit) {
      hit = input.sourcePathExists(path)
      evidenceCache.set(path, hit)
    }
    return hit
  }
  const context: CheckContext = {
    sourceUrl,
    source: input.source,
    skill: input.skill,
    bundle: input.bundle,
    evidenceExists,
  }

  const candidates: Candidate[] = []
  for (const [index, op] of ops.entries()) {
    if (index >= opLimit) {
      reject(
        op.path,
        "op_cap",
        `A step writes at most ${MAX_STEP_OPS} ops and a Workspace at most ${MAX_WORKSPACE_OPS} in a run`,
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
    const before = baseText(op.path)
    if (op.op === "delete") {
      if (fileOwnership(before ?? "", sourceUrl) !== "sole") {
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
    const checked = await checkWrite(op, before, context)
    if ("rule" in checked) reject(op.path, checked.rule, checked.reason)
    else candidates.push(checked)
  }

  const deletes = candidates.filter((c) => c.op === "delete")
  const ownedCount = [...baseEntries.keys()].filter(
    (path) =>
      disallowedPathReason(path) === null &&
      fileOwnership(baseText(path) ?? "", sourceUrl) === "sole",
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

  const tree = await applyOps(input.repoDir, input.baseCommit, accepted)
  const acceptedPaths = new Set(accepted.map((op) => op.path))
  const result = await listTree(input.repoDir, tree)
  for (const path of new Set([...result.keys(), ...baseEntries.keys()])) {
    if (result.get(path) !== baseEntries.get(path) && !acceptedPaths.has(path))
      throw new Error(
        "The result tree changes a path that no accepted op names",
      )
  }
  const opRejections = rejections.filter((r) => r.rule !== "patch_json").length
  const total = ops.length + stagedRejections
  return {
    tree,
    accepted: accepted.map(({ op, path }) => ({ op, path })),
    rejections,
    status: total > 0 && opRejections * 2 > total ? "partial" : "complete",
  }
}

type CheckContext = {
  sourceUrl: string
  source: { url: string; sha: string }
  skill: string
  bundle: string
  evidenceExists: (path: string) => Promise<boolean>
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
    op.op === "create" ? "sole" : fileOwnership(before ?? "", context.sourceUrl)
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
  if (Buffer.byteLength(result.output) > MAX_FILE_BYTES)
    return {
      rule: "size_cap",
      reason: `The file is larger than ${MAX_FILE_BYTES} bytes`,
    }
  return { op: op.op, path: op.path, ...result }
}

type WriteOutput = { output: string; links: string[]; claimTargets: string[] }

const AREA_PATH = /^knowledge\/instructions\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/

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

  if (
    !isDeepStrictEqual(humanBlocks(text), humanBlocks(before ?? "")) ||
    markerCount(text) !== markerCount(before ?? "")
  )
    return {
      rule: "human_section",
      reason: "The human section must not change",
    }
  const content = contentProblem(text)
  if (content) return content
  const heading = deniedHeading(front.body)
  if (heading) return heading
  const injection = injectionProblem(text)
  if (injection) return injection

  const beforeSources = fileSources(before ?? "")
  const others = beforeSources.filter((s) => s !== context.sourceUrl)
  if (others.length > 0 && attributes.name !== baseAttributes.name)
    return shared("Only the source that owns the file alone can rename it")
  if (others.length > 0 && attributes.summary !== baseAttributes.summary)
    return shared(
      "Only the source that owns the file alone can change the summary",
    )

  const withoutHuman = (body: string) => body.replace(HUMAN_BLOCK, "")
  const after = parseAreaBody(withoutHuman(front.body), normalizeSourceUrl)
  if ("error" in after) return shared(after.error)
  let beforeArea: AreaFile | null = null
  if (before && baseFront) {
    const read = parseAreaBody(withoutHuman(baseFront.body), normalizeSourceUrl)
    beforeArea = "error" in read ? null : read
  }
  const change = checkAreaChange({
    before: beforeArea,
    after,
    source: context.sourceUrl,
    beforeSources,
  })
  if ("error" in change) return shared(change.error)
  for (const path of change.freshEvidence)
    if (!(await context.evidenceExists(path)))
      return {
        rule: "evidence",
        reason: "An evidence path does not exist at the source revision",
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

  if (
    !isDeepStrictEqual(humanBlocks(text), humanBlocks(before ?? "")) ||
    markerCount(text) !== markerCount(before ?? "")
  )
    return {
      rule: "human_section",
      reason: "The human section must not change",
    }

  const content = contentProblem(text)
  if (content) return content
  const heading = deniedHeading(front.body)
  if (heading) return heading
  const injection = injectionProblem(text)
  if (injection) return injection

  const claims = attributes.claims ?? []
  const baseClaims = Array.isArray(baseAttributes.claims)
    ? baseAttributes.claims.map(withoutConfidence)
    : []
  const fresh = claims.filter(
    (claim) =>
      !baseClaims.some((b) => isDeepStrictEqual(b, withoutConfidence(claim))),
  )
  const evidence = await evidenceProblem(fresh, context)
  if (evidence) return evidence

  const stamped = {
    kind: attributes.kind,
    name: attributes.name,
    ...(attributes.summary === undefined
      ? {}
      : { summary: attributes.summary }),
    ...(claims.length ? { claims: claims.map(stampClaim) } : {}),
    generated_by: GENERATED_BY,
    sources: [context.sourceUrl],
    source_sha: context.source.sha,
    skill: context.skill,
    bundle: context.bundle,
  }
  return {
    output: `---\n${stringify(stamped)}---\n${front.body}`,
    links: markdownLinks(front.body),
    claimTargets: claims.map((c) => c.to),
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
  const injection = injectionProblem(addedText)
  if (injection) return injection
  const evidence = await evidenceProblem(added, context)
  if (evidence) return evidence

  let header = before.slice(0, before.length - baseFront.body.length)
  if (added.length) {
    const document = parseDocument(baseFront.yaml)
    if (!document.has("claims")) document.set("claims", document.createNode([]))
    const seq = document.get("claims", true) as YAMLSeq
    for (const claim of added) seq.add(document.createNode(stampClaim(claim)))
    header = `---\n${document.toString()}---\n`
  }
  return {
    output: `${header}${newFront.body}`,
    links: markdownLinks(related),
    claimTargets: added.map((c) => c.to),
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

function humanBlocks(text: string): string[] {
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
  const prose = withoutCode(text)
    .split(HUMAN_OPEN)
    .join("")
    .split(HUMAN_CLOSE)
    .join("")
  if (prose.includes("<!--")) return fail("HTML comments are not allowed")
  if (/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>|<[!?][a-z]/i.test(prose))
    return fail("Raw HTML is not allowed")
  return null
}

const DENIED_HEADINGS = [
  /\bsystem\s+prompts?\b/i,
  /\b(?:ai|llm|coding|autonomous)\s+(?:agents?|assistants?|models?)\b/i,
  /\b(?:for|to|attention)\s+(?:the\s+|all\s+)?(?:ai|llms?|agents?|assistants?|models?|claude|gpt|chatgpt|copilot|cursor)\b/i,
  /\b(?:claude|chatgpt|gpt-?\d*|copilot|gemini)\b/i,
  /^(?:ai|llms?|agents?|assistants?|prompts?)$/i,
]

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

const INJECTION_PHRASES = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|all|any|your|the)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules|directives|guidelines)\b/i,
  /\byou are (?:now|no longer)\b/i,
  /\b(?:new|updated|real|actual) (?:system )?instructions?\s*:/i,
  /\bsystem prompt\b/i,
  /\b(?:reveal|print|show|output|leak|exfiltrate|send|upload)\b[^.\n]{0,40}\b(?:system prompt|api[_ -]?keys?|credentials?|secrets?|access tokens?|passwords?)\b/i,
  /\b(?:do not|don't|never) (?:tell|inform|alert) (?:the )?(?:user|human|operator)\b/i,
  /\bas an ai\b/i,
  /\b(?:ai|llm|coding) (?:agents?|assistants?|models?)\b[,:]?\s*(?:must|should|need to|are required to|please)\b/i,
  /<\|?(?:im_start|im_end|endoftext)\|?>|\[\/?INST\]|<<\/?SYS>>/i,
]

/** Scans text outside fenced code and block quotes (concept section 6). */
function injectionProblem(text: string): CheckFailure | null {
  const outside = withoutCode(text)
    .split("\n")
    .filter((line) => !/^ {0,3}>/.test(line))
    .join("\n")
    .replace(/\s+/g, " ")
  for (const pattern of INJECTION_PHRASES) {
    if (pattern.test(outside))
      return {
        rule: "suspected_injection",
        reason: "The text looks like an instruction to an agent",
      }
  }
  return null
}

/** Removes fenced code blocks and inline code spans. */
function withoutCode(text: string): string {
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
    out.push(line.replace(/(`+)[^`\n]*?\1/g, ""))
  }
  return out.join("\n")
}

function markdownLinks(body: string): string[] {
  const prose = withoutCode(body)
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

export function splitFrontMatter(
  text: string,
): { yaml: string; body: string } | null {
  const match = /^---[ \t]*\r?\n((?:.*\n)*?)---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return null
  return { yaml: match[1] ?? "", body: text.slice(match[0].length) }
}

export function parseYamlObject(yaml: string): Record<string, unknown> | null {
  try {
    const value = parseYaml(yaml) ?? {}
    return typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function normalizeSourceUrl(url: string): string {
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
): Promise<Map<string, z.infer<typeof PatchJsonSchema>["ops"][number]>> {
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
    return entries
  }
  const raw = await readFile(file, "utf8")
  let parsed: z.infer<typeof PatchJsonSchema>
  try {
    parsed = PatchJsonSchema.parse(JSON.parse(raw))
  } catch {
    reject("patch.json", "patch_json", "patch.json does not match the schema")
    return entries
  }
  for (const op of parsed.ops) {
    if (entries.has(op.path))
      reject(op.path, "patch_json", "patch.json names the path more than once")
    else entries.set(op.path, op)
  }
  return entries
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

async function listTree(
  repoDir: string,
  commit: string,
): Promise<Map<string, string>> {
  const out = await git(repoDir, ["ls-tree", "-r", "-z", "--full-tree", commit])
  const entries = new Map<string, string>()
  for (const record of out.toString("utf8").split("\0")) {
    if (!record) continue
    const tab = record.indexOf("\t")
    const [mode, type, sha] = record.slice(0, tab).split(" ")
    if (type === "blob" && mode !== "120000" && sha)
      entries.set(record.slice(tab + 1), sha)
  }
  return entries
}

async function blobId(repoDir: string, content: Buffer): Promise<string> {
  return (await git(repoDir, ["hash-object", "--stdin"], { input: content }))
    .toString()
    .trim()
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
): Promise<string> {
  const env = {
    GIT_INDEX_FILE: join(
      tmpdir(),
      `ctxpipe-patch-index-${process.pid}-${Math.random().toString(36).slice(2)}`,
    ),
  }
  try {
    await git(repoDir, ["read-tree", baseCommit], { env })
    const lines: string[] = []
    for (const op of ops) {
      if (op.op === "delete") {
        lines.push(`0 ${"0".repeat(40)}\t${op.path}`)
        continue
      }
      const sha = (
        await git(repoDir, ["hash-object", "-w", "--stdin"], {
          input: op.output ?? "",
        })
      )
        .toString()
        .trim()
      lines.push(`100644 ${sha}\t${op.path}`)
    }
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
