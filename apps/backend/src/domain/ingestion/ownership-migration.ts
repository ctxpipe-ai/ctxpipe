import { isMap, isScalar, isSeq } from "yaml"
import { checkSourcePath } from "../workspace-sources/source-file.js"
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
 * ingestion v2: `generated_by: ctxpipe-extract` and, in `sources`, the path
 * of the source file that declares that repository in the Workspace
 * (`sourcePaths`, ADR-050 revision 2026-10-16). The front matter gets the
 * shape that the ingestion v2 validator accepts, so a later v2 edit that
 * keeps it passes:
 *
 * - It removes each key that ingestion v2 does not know (`import_key`,
 *   `source`, `confidence`, and others).
 * - It sets `name` from the old `name`, the first `# ` heading, or the file
 *   name.
 * - Each old claim stays with all its keys, also `valid_from`, `valid_to`,
 *   and `source`, because hydrate and graph traversal read them for history.
 *   It gets `evidence` of kind `legacy`: the old pipeline did not record how
 *   it found the claim. A claim with no `confidence` gets the old file
 *   `confidence`, which hydrate used for it. Only a claim with no target
 *   (`to`) cannot stay, because hydrate cannot read it either.
 *   `onDroppedClaim` gets each such claim and the reason.
 *
 * The body stays byte for byte, so human sections and human text stay. A
 * file with no `generated_by: ctxpipe` (a human took it over, or ingestion v2
 * already owns it) does not change. A file with no absolute source URL, or
 * with the Workspace repository as its source, does not change either: no
 * ingestion v2 source can own it (ADR-052 section 3). A file whose source
 * repository has no source file in the Workspace does not change: no source
 * path can own it. It moves when a source file names the repository.
 */
export function ownershipMigrationFiles(input: {
  workspaceRepositoryUrl: string
  /**
   * The source file path of each repository that a GitHub source file of
   * the Workspace declares, by normalized repository URL
   * (`repositorySourcePathsAtRevision`).
   */
  sourcePaths: ReadonlyMap<string, string>
  files: ReadonlyArray<{ path: string; content: string }>
  onDroppedClaim?: (drop: {
    path: string
    index: number
    reason: string
  }) => void
  /**
   * Gets the front matter keys that the migration removes from one file: the
   * keys that ingestion v2 does not know, and a `summary` that is not text
   * or is longer than 1000 characters. `source` is not in the list: its
   * repository moves into `sources`.
   */
  onRemovedKeys?: (removed: { path: string; keys: string[] }) => void
}): Array<{ path: string; content: string }> {
  const workspaceUrl = normalizeWorkspaceRepositoryUrl(
    input.workspaceRepositoryUrl,
  )
  const out: Array<{ path: string; content: string }> = []
  for (const file of input.files) {
    if (!file.path.startsWith("knowledge/") || !file.path.endsWith(".md"))
      continue
    const sourceUrl = legacySourceUrl(file.content, workspaceUrl)
    const sourcePath = sourceUrl ? input.sourcePaths.get(sourceUrl) : undefined
    if (!sourcePath) continue
    out.push({
      path: file.path,
      content: updateKnowledgeMetadata(file.content, (document) => {
        const sources = document.get("sources", true)
        // A value that is not a source path (an old URL) names no source.
        const listed = isSeq(sources)
          ? sources
              .toJSON()
              .filter(
                (s): s is string =>
                  typeof s === "string" && checkSourcePath(s).ok,
              )
          : []
        const claims = legacyClaims(
          document.get("claims", true),
          document.get("confidence"),
          (index, reason) =>
            input.onDroppedClaim?.({ path: file.path, index, reason }),
        )
        const summary = document.get("summary")
        const name = fileName(
          document.get("name"),
          parseSimpleFrontMatter(file.content).body,
          file.path,
        )
        if (!isMap(document.contents)) return
        const removed: string[] = []
        for (const pair of [...document.contents.items]) {
          const key = isScalar(pair.key) ? pair.key.value : pair.key
          if (typeof key !== "string" || !V2_KEYS.has(key)) {
            document.contents.delete(pair.key)
            if (key !== "source") removed.push(String(key))
          }
        }
        document.set("name", name)
        if (
          document.has("summary") &&
          (typeof summary !== "string" || summary.length > 1000)
        ) {
          document.delete("summary")
          removed.push("summary")
        }
        if (removed.length)
          input.onRemovedKeys?.({ path: file.path, keys: removed })
        if (claims.length) document.set("claims", claims)
        else document.delete("claims")
        document.set("generated_by", "ctxpipe-extract")
        document.set(
          "sources",
          listed.includes(sourcePath) ? listed : [...listed, sourcePath],
        )
      }),
    })
  }
  return out
}

/**
 * The source repository of a file that the old pipeline wrote and that the
 * migration gives to ingestion v2: a `generated_by: ctxpipe` file with an
 * absolute `source` URL that is not the Workspace repository. Null for each
 * other file. `workspaceUrl` is normalized.
 */
export function legacySourceUrl(
  content: string,
  workspaceUrl: string,
): string | null {
  const parsed = parseSimpleFrontMatter(content)
  if (parsed.malformed || parsed.attributes.generated_by !== "ctxpipe")
    return null
  const source = parsed.attributes.source
  if (
    typeof source !== "string" ||
    !/^(?:(?:https?|ssh|git):\/\/|git@)/i.test(source.trim())
  )
    return null
  const sourceUrl = normalizeWorkspaceRepositoryUrl(source.split("#")[0] ?? "")
  return sourceUrl === workspaceUrl ? null : sourceUrl
}

function legacyClaims(
  raw: unknown,
  fileConfidence: unknown,
  drop: (index: number, reason: string) => void,
): Array<Record<string, unknown>> {
  if (!isSeq(raw)) return []
  const claims: Array<Record<string, unknown>> = []
  for (const [index, item] of (raw.toJSON() as unknown[]).entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      drop(index, "The claim is not a map")
      continue
    }
    const claim = item as Record<string, unknown>
    if (typeof claim.to !== "string" || !claim.to.trim()) {
      drop(index, "The claim has no target (to)")
      continue
    }
    claims.push({
      ...(claim.confidence === undefined && typeof fileConfidence === "number"
        ? { confidence: fileConfidence }
        : {}),
      ...claim,
      evidence: { kind: "legacy" },
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
