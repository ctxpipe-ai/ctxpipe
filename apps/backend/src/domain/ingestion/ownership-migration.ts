import { isMap, isScalar, isSeq } from "yaml"
import { updateKnowledgeMetadata } from "../workspaces/knowledge-metadata.js"
import { parseSimpleFrontMatter } from "../workspaces/layout.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"

/** The front matter keys that the ingestion v2 validator accepts. */
const V2_KEYS = new Set([
  "kind",
  "name",
  "summary",
  "claims",
  "generated_by",
  "sources",
  "root",
  "source_sha",
  "skill",
  "bundle",
])

/**
 * The one-time ownership migration at the switch (ADR-052 section 3, CTX-584
 * T22). A file that the old pipeline wrote has `generated_by: ctxpipe` and a
 * `source` URL in its source repository. This write gives the file to
 * ingestion v2: `generated_by: ctxpipe-extract` and that repository in
 * `sources`. The front matter gets the shape that the ingestion v2 validator
 * accepts, so a later v2 edit that keeps it passes:
 *
 * - It removes each key that ingestion v2 does not know (`import_key`,
 *   `source`, `confidence`, and others).
 * - It sets `name` from the old `name`, the first `# ` heading, or the file
 *   name.
 * - Each old claim gets `evidence` (the path of its `source`, else the path
 *   of the file `source`, with kind `model`). It drops a closed claim (with
 *   `valid_to`), and a claim with no valid target, predicate, or path.
 *
 * The body stays byte for byte, so human sections and human text stay. A
 * file with no `generated_by: ctxpipe` (a human took it over, or ingestion v2
 * already owns it) does not change. A file with no absolute source URL, or
 * with the Workspace repository as its source, does not change either: no
 * ingestion v2 source can own it (ADR-052 section 3).
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
    const filePath = sourcePath(source)
    out.push({
      path: file.path,
      content: updateKnowledgeMetadata(file.content, (document) => {
        const sources = document.get("sources", true)
        const listed = isSeq(sources)
          ? sources.toJSON().filter((s): s is string => typeof s === "string")
          : []
        const known = new Set(listed.map(normalizeWorkspaceRepositoryUrl))
        const claims = v2Claims(document.get("claims", true), filePath)
        const summary = document.get("summary")
        const name = fileName(document.get("name"), parsed.body, file.path)
        if (!isMap(document.contents)) return
        for (const pair of [...document.contents.items]) {
          const key = isScalar(pair.key) ? pair.key.value : pair.key
          if (typeof key !== "string" || !V2_KEYS.has(key))
            document.contents.delete(pair.key)
        }
        document.set("name", name)
        if (typeof summary !== "string" || summary.length > 1000)
          document.delete("summary")
        if (claims.length) document.set("claims", claims)
        else document.delete("claims")
        document.set("generated_by", "ctxpipe-extract")
        document.set(
          "sources",
          known.has(sourceUrl) ? listed : [...listed, sourceUrl],
        )
      }),
    })
  }
  return out
}

/** The relative path after `#` in a source URL, or a relative path as is. */
function sourcePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const value = raw.trim()
  const path = /^(?:(?:https?|ssh|git):\/\/|git@)/i.test(value)
    ? value.split("#")[1]
    : value
  if (
    !path ||
    path.length > 500 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((s) => s === "" || s === "." || s === "..")
  )
    return null
  return path
}

function v2Claims(
  raw: unknown,
  filePath: string | null,
): Array<Record<string, unknown>> {
  if (!isSeq(raw)) return []
  const claims: Array<Record<string, unknown>> = []
  for (const item of raw.toJSON() as unknown[]) {
    if (!item || typeof item !== "object") continue
    const claim = item as Record<string, unknown>
    const to = typeof claim.to === "string" ? claim.to.trim() : ""
    const predicate = claim.predicate
    const path =
      claim.source === undefined ? filePath : sourcePath(claim.source)
    if (
      claim.valid_to != null ||
      !to ||
      to.length > 500 ||
      typeof predicate !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(predicate) ||
      !path
    )
      continue
    const confidence = claim.confidence
    claims.push({
      to,
      predicate,
      evidence: { path, kind: "model" },
      ...(typeof confidence === "number" && confidence >= 0 && confidence <= 1
        ? { confidence }
        : {}),
    })
  }
  return claims
}

function fileName(raw: unknown, body: string, path: string): string {
  const fromKey = typeof raw === "string" ? raw.trim() : ""
  const heading = /^# +(.+?)\s*#*\s*$/m.exec(body)?.[1]?.trim() ?? ""
  const base = path.slice(path.lastIndexOf("/") + 1, -".md".length)
  return (fromKey || heading || base).slice(0, 200)
}
