import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isMap, isSeq } from "yaml"
import {
  type GitPack,
  listPackBlobs,
  readGitFiles,
  withGitDirectory,
} from "../../services/git/pack.js"
import {
  commitGitTree,
  type GitFileChange,
  stageGitFiles,
} from "../../services/git/write-tree.js"
import {
  editableMetadataNode,
  updateKnowledgeMetadata,
} from "../workspaces/knowledge-metadata.js"
import { retractExtractionClaims } from "../workspaces/retract-extraction.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import {
  checkAreaChange,
  parseAreaBody,
  withoutAreaSource,
} from "./area-file.js"
import { parseYamlObject, splitFrontMatter } from "./front-matter.js"
import {
  legacySourceUrl,
  ownershipMigrationFiles,
} from "./ownership-migration.js"
import {
  AREA_PATH,
  fileOwnership,
  fileSources,
  humanBlocks,
  humanSectionsKept,
  MAX_STEP_OPS,
  normalizeSourceUrl,
  validatePatchStep,
} from "./patch-validator.js"

const HOST_FIELDS = [
  "generated_by",
  "sources",
  "root",
  "source_sha",
  "skill",
  "bundle",
] as const

/**
 * The host retraction of a source repository that a Workspace unlinks
 * (ADR-052 section 3, CTX-720). It reads the `knowledge/**.md` files at the
 * pack commit and returns one change set:
 *
 * - A file that the repository owns alone is deleted. The patch validator
 *   checks each delete as a step with a gone root (`rootGone`), so the
 *   delete cap does not apply.
 * - A file that it owns alone, but with a human section, goes to the humans:
 *   the host fields and the extracted claims go, the body stays.
 * - A shared area file loses the evidence lines and notes of the repository,
 *   and each rule that has no other evidence. The shared-file check of the
 *   validator (`checkAreaChange`) proves that the other sources keep theirs.
 *   Another shared file loses only the repository in `sources`.
 * - Each open claim whose `source` names the repository gets `valid_to`
 *   (the ADR-052 full retraction). A closed claim keeps its dates.
 * - An old pipeline file that the ownership migration did not move yet is
 *   retracted as the migration would give it: a `generated_by: ctxpipe` file
 *   whose absolute `source` URL is the repository (`legacySourceUrl`) is the
 *   repository's file. Else a later migration would give it to ingestion v2
 *   with only the unlinked repository in `sources`. Its delete goes through
 *   the same validator, on a local commit with the migrated text.
 *
 * Human sections stay byte for byte. Each edit gets the checks of a staged
 * write: the same human sections, and front matter that is a YAML map. An
 * edit of a file that is not an area file keeps the body byte for byte.
 */
export async function planUnlinkRetraction(input: {
  pack: GitPack
  sourceUrl: string
  workspaceRepositoryUrl: string
  observedAt: string
}): Promise<{ files: GitFileChange[]; deletePaths: string[] }> {
  const source = normalizeSourceUrl(input.sourceUrl)
  const before = await readGitFiles(
    input.pack,
    (path) => path.startsWith("knowledge/") && path.endsWith(".md"),
  )
  const workspaceUrl = normalizeWorkspaceRepositoryUrl(
    input.workspaceRepositoryUrl,
  )
  const deletePaths: string[] = []
  // Old pipeline files: the patch validator reads ownership at its base
  // commit, so it checks these deletes on a commit with the migrated text.
  const legacyDeletes: Array<{ path: string; content: string }> = []
  const kept: Array<{ path: string; content: string }> = []
  for (const file of before) {
    const legacy = legacySourceUrl(file.content, workspaceUrl)
    const migrated =
      legacy !== null && normalizeSourceUrl(legacy) === source
        ? ownershipMigrationFiles({
            workspaceRepositoryUrl: input.workspaceRepositoryUrl,
            files: [file],
          })[0]
        : undefined
    const content = migrated?.content ?? file.content
    const ownership = fileOwnership(content, source)
    if (ownership === "sole" && humanBlocks(content).length === 0) {
      if (migrated) legacyDeletes.push(migrated)
      else deletePaths.push(file.path)
    } else if (ownership === "sole")
      kept.push({ path: file.path, content: toHumanFile(content) })
    else if (ownership === "shared")
      kept.push({
        path: file.path,
        content: withoutSharedSource(file.path, content, source),
      })
    else kept.push({ path: file.path, content })
  }
  const retracted = retractExtractionClaims({
    extraction: {
      repositoryUrl: input.sourceUrl,
      claims: [],
      retraction: { mode: "full", observedAt: input.observedAt },
    },
    workspaceRepositoryUrl: input.workspaceRepositoryUrl,
    files: kept,
    referencePaths: new Map(),
  })
  const original = new Map(before.map((file) => [file.path, file.content]))
  const files = retracted
    .filter((file) => original.get(file.path) !== file.content)
    .map((file) => ({ path: file.path, content: file.content }))
  for (const file of files)
    checkRetractionEdit(file.path, original.get(file.path) ?? "", file.content)
  if (deletePaths.length)
    await validateDeletes(input.pack, input.sourceUrl, deletePaths)
  const legacyDeletePaths = legacyDeletes.map((file) => file.path)
  if (legacyDeletes.length)
    await validateDeletes(
      // A local commit that only the validator reads; it is never pushed.
      await commitGitTree(await stageGitFiles(input.pack, legacyDeletes), {
        subject: "Migrate the old pipeline files that the retraction deletes",
        createdAt: input.observedAt,
      }),
      input.sourceUrl,
      legacyDeletePaths,
    )
  return { files, deletePaths: [...deletePaths, ...legacyDeletePaths].sort() }
}

/** The checks of a staged write that apply to a host edit (ADR-052 section 3). */
function checkRetractionEdit(path: string, before: string, after: string) {
  const front = splitFrontMatter(after)
  if (!front || !parseYamlObject(front.yaml))
    throw new Error(`The retraction of ${path} has no YAML front matter`)
  if (!humanSectionsKept(before, after))
    throw new Error(`The retraction of ${path} changes a human section`)
  if (!AREA_PATH.test(path) && front.body !== splitFrontMatter(before)?.body)
    throw new Error(`The retraction of ${path} changes the body`)
}

/** The extracted part goes; the body and the legacy claims (history) stay. */
function toHumanFile(content: string): string {
  return updateKnowledgeMetadata(content, (document) => {
    for (const field of HOST_FIELDS) document.delete(field)
    const claims = editableMetadataNode(document, "claims")
    if (!isSeq(claims)) return
    claims.items = claims.items.filter((claim) => {
      if (!isMap(claim)) return true
      const evidence = claim.get("evidence", true)
      return isMap(evidence) && evidence.get("kind") === "legacy"
    })
    if (claims.items.length === 0) document.delete("claims")
  })
}

function withoutSharedSource(
  path: string,
  content: string,
  source: string,
): string {
  const others = fileSources(content).filter((url) => url !== source)
  let next = content
  if (AREA_PATH.test(path)) {
    const front = splitFrontMatter(content)
    if (!front) throw new Error(`The area file ${path} has no front matter`)
    // Each human section stands in as one marker, so that the edit reads
    // the evidence lines before and after it. A human section can be in the
    // middle of the file, because a person can move it there.
    const blocks = humanBlocks(front.body)
    // A random tag, so that no text of the file looks like a marker.
    const tag = `ctxpipe-human-${randomUUID()}`
    const marker = (i: number) => `${tag}:${i}:${tag}`
    const markers = () => new RegExp(`${tag}:(\\d+):${tag}`, "g")
    let marked = front.body
    for (const [i, block] of blocks.entries())
      marked = marked.replace(block, () => marker(i))
    const edited = withoutAreaSource(marked, source, normalizeSourceUrl)
    if (
      (edited.match(markers()) ?? []).join("") !==
      blocks.map((_, i) => marker(i)).join("")
    )
      throw new Error(
        `The retraction of ${path} would move or remove a human section`,
      )
    // The validator reads an area body with no human sections.
    const unmarked = (body: string) => body.replace(markers(), "")
    const beforeArea = parseAreaBody(unmarked(marked), normalizeSourceUrl)
    const afterArea = parseAreaBody(unmarked(edited), normalizeSourceUrl)
    if ("error" in beforeArea || "error" in afterArea)
      throw new Error(
        `The area file ${path} has a form that the host cannot read`,
      )
    const change = checkAreaChange({
      before: beforeArea,
      after: afterArea,
      source,
      beforeSources: fileSources(content),
    })
    if ("error" in change)
      throw new Error(
        `The retraction of ${path} fails a check: ${change.error}`,
      )
    // `sources` loses the repository, so no evidence line or note of it
    // can stay.
    if (
      afterArea.rules.some((rule) => rule.sources.has(source)) ||
      afterArea.notes.some((note) => normalizeSourceUrl(note.source) === source)
    )
      throw new Error(
        `The retraction of ${path} leaves evidence of the repository`,
      )
    const restored = edited.replace(
      markers(),
      (_, i: string) => blocks[Number(i)] ?? "",
    )
    next = `${content.slice(0, content.length - front.body.length)}${restored}`
  }
  return updateKnowledgeMetadata(next, (document) => {
    const listed = document.get("sources", true)
    if (!isSeq(listed)) return
    listed.items = listed.items.filter((item) => {
      const value = (item as { value?: unknown }).value
      return (
        typeof value !== "string" || others.includes(normalizeSourceUrl(value))
      )
    })
  })
}

/** Each delete goes through the patch validator, as a step with a gone root. */
async function validateDeletes(
  pack: GitPack,
  sourceUrl: string,
  paths: readonly string[],
): Promise<void> {
  await withGitDirectory(
    pack.sha,
    async (repoDir) => {
      const blobs = new Map(
        // Root-relative paths, as `readGitFiles` gives them.
        (await listPackBlobs(repoDir, pack)).map((b) => [b.path, b.sha]),
      )
      // A step has at most MAX_STEP_OPS ops, so the deletes go in batches
      // on the same base. A delete does not depend on another one.
      for (let at = 0; at < paths.length; at += MAX_STEP_OPS) {
        const batch = paths.slice(at, at + MAX_STEP_OPS)
        const stagedDir = await mkdtemp(join(tmpdir(), "ctxpipe-unlink-"))
        try {
          await mkdir(join(stagedDir, "files"), { recursive: true })
          await writeFile(
            join(stagedDir, "patch.json"),
            JSON.stringify({
              ops: batch.map((path) => ({
                op: "delete",
                path,
                baseBlob: blobs.get(path),
              })),
            }),
          )
          const result = await validatePatchStep({
            repoDir,
            baseCommit: pack.sha,
            stagedDir,
            // A delete stamps no source revision; the Workspace commit
            // stands in.
            source: { url: sourceUrl, sha: pack.sha },
            skill: "unlink-retraction",
            bundle: "host",
            sourcePathExists: async () => false,
            readSourceFile: async () => null,
            rootGone: true,
            rootPath: pack.root ?? "",
          })
          if (
            result.rejections.length ||
            result.accepted.length !== batch.length
          )
            throw new Error(
              `The unlink retraction fails the patch validator: ${result.rejections
                .slice(0, 5)
                .map((r) => `${r.path}: ${r.rule}`)
                .join("; ")}`,
            )
        } finally {
          await rm(stagedDir, { recursive: true, force: true })
        }
      }
    },
    pack,
  )
}
