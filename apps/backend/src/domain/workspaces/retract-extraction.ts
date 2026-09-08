import { posix } from "node:path"
import { isAlias, isMap, isSeq } from "yaml"
import type { WorkspaceExtraction } from "./extraction.js"
import {
  editableMetadataNode,
  materializeMetadataAlias,
  updateKnowledgeMetadata,
} from "./knowledge-metadata.js"
import { parseSimpleFrontMatter } from "./layout.js"
import type { ExistingKnowledgeFile } from "./migration-export.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

/** Source paths belong to the captured repository, including files deleted since capture. */
function sourcePath(
  source: unknown,
  fromPath: string,
  repositoryUrl: string,
  workspaceRepositoryUrl: string,
): string | null {
  if (typeof source !== "string" || !source) return null
  if (/^(?:https?|ssh|git):\/\//i.test(source) || source.startsWith("git@")) {
    const [url, fragment = ""] = source.split("#")
    if (
      normalizeWorkspaceRepositoryUrl(url ?? "") !==
      normalizeWorkspaceRepositoryUrl(repositoryUrl)
    )
      return null
    return fragment
  }
  if (
    normalizeWorkspaceRepositoryUrl(repositoryUrl) !==
    normalizeWorkspaceRepositoryUrl(workspaceRepositoryUrl)
  )
    return null
  if (!source.startsWith(".") && !source.includes("/")) return null
  const path = posix.normalize(posix.join(posix.dirname(fromPath), source))
  return path.startsWith("../") || path.startsWith("/") ? null : path
}

/** Expire only evidence inspected by this capture; preserve unknown metadata and prose. */
export function retractExtractionClaims(input: {
  extraction: WorkspaceExtraction
  workspaceRepositoryUrl: string
  files: ExistingKnowledgeFile[]
  referencePaths: ReadonlyMap<string, string>
}): ExistingKnowledgeFile[] {
  const scope = input.extraction.retraction
  if (!scope) return input.files
  const assertions = new Set<string>()
  for (const claim of input.extraction.claims) {
    const from = input.referencePaths.get(claim.subjectRef)
    const to = input.referencePaths.get(claim.objectRef)
    if (from && to)
      assertions.add(
        JSON.stringify([from, to, claim.predicate, claim.sourcePath ?? null]),
      )
  }
  return input.files.map((file) => {
    const parsed = parseSimpleFrontMatter(file.content)
    if (parsed.malformed || !Array.isArray(parsed.attributes.claims))
      return file
    const actions = parsed.attributes.claims.map(
      (claim): "expire" | "reassert" | null => {
        if (!claim || typeof claim !== "object") return null
        const row = claim as Record<string, unknown>
        if (typeof row.to !== "string" || typeof row.predicate !== "string")
          return null
        if (
          typeof row.valid_from === "string" &&
          Date.parse(row.valid_from) > Date.parse(scope.observedAt)
        )
          return null
        const path = sourcePath(
          row.source,
          file.path,
          input.extraction.repositoryUrl,
          input.workspaceRepositoryUrl,
        )
        if (path === null) return null
        const toPath = posix.normalize(
          posix.join(posix.dirname(file.path), row.to),
        )
        const asserted =
          assertions.has(
            JSON.stringify([file.path, toPath, row.predicate, path]),
          ) ||
          assertions.has(
            JSON.stringify([file.path, toPath, row.predicate, null]),
          )
        const expired =
          typeof row.valid_to === "string" &&
          Date.parse(row.valid_to) <= Date.parse(scope.observedAt)
        if (asserted) return expired ? "reassert" : null
        if (expired) return null
        return scope.mode === "full" ||
          scope.paths.some(
            (affected) => path === affected || path.startsWith(`${affected}/`),
          )
          ? "expire"
          : null
      },
    )
    if (!actions.some(Boolean)) return file
    return {
      ...file,
      content: updateKnowledgeMetadata(file.content, (document) => {
        const claims = editableMetadataNode(document, "claims")
        if (!isSeq(claims)) return
        for (const [index, action] of actions.entries()) {
          if (!action) continue
          let claim = claims.items[index]
          if (isAlias(claim)) {
            claim = materializeMetadataAlias(document, claim)
            claims.items[index] = claim
          }
          if (!isMap(claim)) continue
          if (action === "expire") claim.set("valid_to", scope.observedAt)
          else {
            claim.delete("valid_to")
            claim.set("valid_from", scope.observedAt)
          }
        }
      }),
    }
  })
}
