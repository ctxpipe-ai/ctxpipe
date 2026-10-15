import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isMap, isSeq } from "yaml"
import {
  type GitPack,
  listTreeBlobs,
  readGitFiles,
  withGitDirectory,
} from "../../services/git/pack.js"
import type { GitFileChange } from "../../services/git/write-tree.js"
import {
  editableMetadataNode,
  updateKnowledgeMetadata,
} from "../workspaces/knowledge-metadata.js"
import { retractExtractionClaims } from "../workspaces/retract-extraction.js"
import {
  checkAreaChange,
  parseAreaBody,
  withoutAreaSource,
} from "./area-file.js"
import {
  AREA_PATH,
  fileOwnership,
  fileSources,
  humanBlocks,
  MAX_STEP_OPS,
  normalizeSourceUrl,
  splitFrontMatter,
  validatePatchStep,
} from "./patch-validator.js"

const HUMAN_OPEN = "<!-- ctxpipe:human -->"
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
 *
 * Human sections stay byte for byte.
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
  const deletePaths: string[] = []
  const kept: Array<{ path: string; content: string }> = []
  for (const file of before) {
    const ownership = fileOwnership(file.content, source)
    if (ownership === "sole" && humanBlocks(file.content).length === 0)
      deletePaths.push(file.path)
    else if (ownership === "sole")
      kept.push({ path: file.path, content: toHumanFile(file.content) })
    else if (ownership === "shared")
      kept.push({
        path: file.path,
        content: withoutSharedSource(file.path, file.content, source),
      })
    else kept.push(file)
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
  if (deletePaths.length)
    await validateDeletes(input.pack, input.sourceUrl, deletePaths)
  return { files, deletePaths }
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
    // The script writes human sections at the end of an area file.
    const humanAt = front.body.indexOf(HUMAN_OPEN)
    const generated = humanAt === -1 ? front.body : front.body.slice(0, humanAt)
    const rest = humanAt === -1 ? "" : front.body.slice(humanAt)
    const edited = withoutAreaSource(generated, source, normalizeSourceUrl)
    const beforeArea = parseAreaBody(generated, normalizeSourceUrl)
    const afterArea = parseAreaBody(edited, normalizeSourceUrl)
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
    next = `${content.slice(0, content.length - front.body.length)}${edited}${rest}`
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
        (await listTreeBlobs(repoDir, pack.sha)).map((b) => [b.path, b.sha]),
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
