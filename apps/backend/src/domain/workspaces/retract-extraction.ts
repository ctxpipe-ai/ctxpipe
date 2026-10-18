import { posix } from "node:path"
import { isAlias, isMap, isSeq } from "yaml"
import {
  editableMetadataNode,
  materializeMetadataAlias,
  updateKnowledgeMetadata,
} from "./knowledge-metadata.js"
import { parseSimpleFrontMatter } from "./layout.js"
import type { ExistingKnowledgeFile } from "./migration-export.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

function canonicalEvidencePath(value: string): string | null {
  const path = posix.normalize(value)
  if (path === ".." || path.startsWith("../") || path.startsWith("/"))
    return null
  const relative = path.replace(/\/$/, "")
  return relative === "." ? "" : relative
}

/** Source paths belong to the captured repository, including files deleted since capture. */
function extractionEvidencePath(
  source: unknown,
  fromPath: string,
  repositoryUrl: string,
  workspaceRepositoryUrl: string,
): string | null {
  if (typeof source !== "string" || !source) return null
  if (/^(?:https?|ssh|git):\/\//i.test(source) || source.startsWith("git@")) {
    const separator = source.indexOf("#")
    const url = separator < 0 ? source : source.slice(0, separator)
    let fragment = separator < 0 ? "" : source.slice(separator + 1)
    if (
      normalizeWorkspaceRepositoryUrl(url ?? "") !==
      normalizeWorkspaceRepositoryUrl(repositoryUrl)
    )
      return null
    try {
      fragment = decodeURIComponent(fragment)
    } catch {
      // Older canonical files may contain a literal, unescaped percent sign.
    }
    return canonicalEvidencePath(fragment)
  }
  if (
    normalizeWorkspaceRepositoryUrl(repositoryUrl) !==
    normalizeWorkspaceRepositoryUrl(workspaceRepositoryUrl)
  )
    return null
  if (!source.startsWith(".") && !source.includes("/")) return null
  return canonicalEvidencePath(posix.join(posix.dirname(fromPath), source))
}

/** Expire the claims whose evidence lies in one source repository; preserve unknown metadata and prose. */
export function retractExtractionClaims(input: {
  repositoryUrl: string
  observedAt: string
  workspaceRepositoryUrl: string
  files: ExistingKnowledgeFile[]
}): ExistingKnowledgeFile[] {
  return input.files.map((file) => {
    const parsed = parseSimpleFrontMatter(file.content)
    if (parsed.malformed || !Array.isArray(parsed.attributes.claims))
      return file
    const expire = parsed.attributes.claims.map((claim): boolean => {
      if (!claim || typeof claim !== "object") return false
      const row = claim as Record<string, unknown>
      if (typeof row.to !== "string" || typeof row.predicate !== "string")
        return false
      if (
        typeof row.valid_from === "string" &&
        Date.parse(row.valid_from) > Date.parse(input.observedAt)
      )
        return false
      const path = extractionEvidencePath(
        row.source,
        file.path,
        input.repositoryUrl,
        input.workspaceRepositoryUrl,
      )
      if (path === null) return false
      const expired =
        typeof row.valid_to === "string" &&
        Date.parse(row.valid_to) <= Date.parse(input.observedAt)
      return !expired
    })
    if (!expire.some(Boolean)) return file
    return {
      ...file,
      content: updateKnowledgeMetadata(file.content, (document) => {
        const claims = editableMetadataNode(document, "claims")
        if (!isSeq(claims)) return
        for (const [index, shouldExpire] of expire.entries()) {
          if (!shouldExpire) continue
          let claim = claims.items[index]
          if (isAlias(claim)) {
            claim = materializeMetadataAlias(document, claim)
            claims.items[index] = claim
          }
          if (isMap(claim)) claim.set("valid_to", input.observedAt)
        }
      }),
    }
  })
}
