import { isSeq } from "yaml"
import { updateKnowledgeMetadata } from "../workspaces/knowledge-metadata.js"
import { parseSimpleFrontMatter } from "../workspaces/layout.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"

/**
 * The one-time ownership migration at the switch (ADR-052 section 3, CTX-584
 * T22). A file that the old pipeline wrote has `generated_by: ctxpipe` and a
 * `source` URL in its source repository. This write gives the file to
 * ingestion v2: `generated_by: ctxpipe-extract` and that repository in
 * `sources`. It also removes `import_key`.
 *
 * Only the front matter changes; the body stays byte for byte, so human
 * sections and human text stay. A file with no `generated_by: ctxpipe` (a
 * human took it over, or ingestion v2 already owns it) does not change. A file
 * with no absolute source URL, or with the Workspace repository as its source,
 * does not change either: no ingestion v2 source can own it.
 */
export function ownershipMigrationFiles(input: {
  workspaceRepositoryUrl: string
  files: ReadonlyArray<{ path: string; content: string }>
}): Array<{ path: string; content: string }> {
  const workspaceUrl = normalizeWorkspaceRepositoryUrl(
    input.workspaceRepositoryUrl,
  )
  const out: Array<{ path: string; content: string }> = []
  for (const file of input.files) {
    if (!file.path.startsWith("knowledge/") || !file.path.endsWith(".md"))
      continue
    const parsed = parseSimpleFrontMatter(file.content)
    if (parsed.malformed || parsed.attributes.generated_by !== "ctxpipe")
      continue
    const source = parsed.attributes.source
    if (
      typeof source !== "string" ||
      !/^(?:(?:https?|ssh|git):\/\/|git@)/i.test(source.trim())
    )
      continue
    const sourceUrl = normalizeWorkspaceRepositoryUrl(
      source.split("#")[0] ?? "",
    )
    if (sourceUrl === workspaceUrl) continue
    out.push({
      path: file.path,
      content: updateKnowledgeMetadata(file.content, (document) => {
        document.delete("import_key")
        document.set("generated_by", "ctxpipe-extract")
        const sources = document.get("sources", true)
        const listed = isSeq(sources)
          ? sources.toJSON().filter((s): s is string => typeof s === "string")
          : []
        const known = new Set(listed.map(normalizeWorkspaceRepositoryUrl))
        document.set(
          "sources",
          known.has(sourceUrl) ? listed : [...listed, sourceUrl],
        )
      }),
    })
  }
  return out
}
