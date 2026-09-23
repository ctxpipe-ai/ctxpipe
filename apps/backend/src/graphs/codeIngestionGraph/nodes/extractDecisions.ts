import {
  fetchFiles,
  globFiles,
} from "../../../domain/codeIngestion/codesearchClient.js"
import { isConnectorMirrorPath } from "../../../domain/codeIngestion/connectorMirrorPaths.js"
import { isUnderDependencyVendorPath } from "../../../domain/codeIngestion/dependencyVendorPaths.js"
import { buildEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import {
  asLocatedPath,
  decisionDedupKey,
  extractBacktickedPaths,
  fileDedupKey,
} from "../../../domain/codeIngestion/referenceResolver.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"
import {
  asString,
  firstParagraph,
  splitFrontmatter,
} from "./connectorFrontmatter.js"
import {
  matchPackageForPath,
  packageRootsFromObjects,
} from "./linkLocatedPaths.js"
import {
  filterPathsByPartialScan,
  partialScanPathsForExtractors,
  shouldSkipCodeExtractorForPartialDiff,
} from "./partialIngestionScope.js"

export const DECISION_GLOBS = [
  "**/adr/**/*.md",
  "**/adrs/**/*.md",
  "**/decisions/**/*.md",
  "**/ADR-*.md",
  // `**` does not reliably descend into dot-directories; name the common one.
  ".ai/memory/decisions/**/*.md",
] as const

const KNOWN_STATUSES = new Set([
  "accepted",
  "proposed",
  "deprecated",
  "superseded",
  "rejected",
  "draft",
])

export type ParsedDecision = {
  title: string
  adrId: string | null
  status: string
  date: string | null
  summary: string
  excerpt: string
  /** ADR numbers this decision supersedes / is superseded by, as `ADR-n`. */
  supersedes: string[]
  supersededBy: string[]
}

function adrIdFrom(text: string): string | null {
  const match = /\bADR[-\s]?0*(\d{1,5})\b/i.exec(text)
  return match?.[1] ? `ADR-${Number(match[1])}` : null
}

function adrIdFromFilename(path: string): string | null {
  const base = path.split("/").pop() ?? ""
  const numbered = /^0*(\d{1,5})[-_.\s]/.exec(base)
  if (numbered?.[1]) return `ADR-${Number(numbered[1])}`
  return adrIdFrom(base)
}

function normalizeStatus(raw: string | null | undefined): string {
  const word =
    (raw ?? "")
      .trim()
      .toLowerCase()
      .split(/[\s|,.;]/)[0] ?? ""
  return KNOWN_STATUSES.has(word) ? word : "unknown"
}

function isoDate(raw: string | null | undefined): string | null {
  const match = /(\d{4}-\d{2}-\d{2})/.exec(raw ?? "")
  return match?.[1] ?? null
}

function sectionParagraph(body: string, heading: RegExp): string | null {
  const match = heading.exec(body)
  if (!match) return null
  const rest = body.slice(match.index + match[0].length)
  const paragraph = firstParagraph(rest)
  return paragraph.length > 0 ? paragraph : null
}

function adrNumbers(text: string, pattern: RegExp): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(pattern)) {
    if (match[1]) found.add(`ADR-${Number(match[1])}`)
  }
  return [...found]
}

/**
 * Parses MADR frontmatter (`status:`, `date:`), this repository's bold header
 * (`**Status:** Accepted | **Date:** 2026-09-16`), `Status:` lines and
 * `## Status` sections. Returns null when no title can be found.
 */
export function parseDecisionMarkdown(
  content: string,
  path: string,
): ParsedDecision | null {
  const split = splitFrontmatter(content)
  const data = split?.data ?? {}
  let body = split?.body ?? content

  const headingMatch = /^#\s+(.+?)\s*$/m.exec(body)
  const rawTitle = headingMatch?.[1] ?? asString(data.title)
  if (!rawTitle) return null
  const title = rawTitle
    .replace(/^ADR[-\s]?\d+\s*[:.\-–—]\s*/i, "")
    .replace(/^\d{1,5}\s*[:.\-–—]\s*/, "")
    .trim()
  if (title.length === 0) return null

  const adrId = adrIdFrom(rawTitle) ?? adrIdFromFilename(path)

  const boldHeader =
    /\*\*Status:\*\*\s*([^|\n]+)(?:\|[^\n]*\*\*Date:\*\*\s*([^|\n]+))?/i.exec(
      body,
    )
  const statusLine = /^Status:\s*(.+)$/im.exec(body)
  const statusSection = /^##\s+Status\s*\n+\s*([^\n]+)/im.exec(body)
  const dateLine = /^Date:\s*(.+)$/im.exec(body)

  const status = normalizeStatus(
    asString(data.status) ??
      boldHeader?.[1] ??
      statusLine?.[1] ??
      statusSection?.[1] ??
      null,
  )
  const date = isoDate(
    asString(data.date) ??
      (data.date instanceof Date ? data.date.toISOString() : null) ??
      boldHeader?.[2] ??
      dateLine?.[1] ??
      null,
  )

  if (headingMatch) {
    body =
      body.slice(0, headingMatch.index) +
      body.slice(headingMatch.index + headingMatch[0].length)
  }
  if (boldHeader) body = body.replace(boldHeader[0], "")
  const excerpt = body.trim().slice(0, 2_000)

  const summary =
    sectionParagraph(body, /^##\s+(?:Context|Decision)\s*$/im) ??
    firstParagraph(excerpt)

  // Supersession is declared in the status header or a field line, often as a
  // link (`Superseded by [ADR-24](...)`, `**Supersedes:** [ADR-21](...)`).
  // In prose only the plain form counts: a linked mention there usually
  // describes another ADR.
  const declared = [
    asString(data.status),
    boldHeader?.[0],
    statusLine?.[0],
    statusSection?.[0],
    ...((split?.body ?? content).match(
      /^\s*(?:\*\*|__)?(?:supersedes|superseded\s+by)\b.*$/gim,
    ) ?? []),
  ].join("\n")
  const supersession = (declaredPattern: RegExp, prosePattern: RegExp) => [
    ...new Set([
      ...adrNumbers(declared, declaredPattern),
      ...adrNumbers(body, prosePattern),
    ]),
  ]

  return {
    title,
    adrId,
    status,
    date,
    summary,
    excerpt,
    supersedes: supersession(
      /\bsupersedes\b[\s:*_[]*ADR[-\s]?0*(\d{1,5})\b/gi,
      /\bsupersedes\s+ADR[-\s]?0*(\d{1,5})\b/gi,
    ),
    supersededBy: supersession(
      /\bsuperseded\s+by\b[\s:*_[]*ADR[-\s]?0*(\d{1,5})\b/gi,
      /\bsuperseded\s+by\s+ADR[-\s]?0*(\d{1,5})\b/gi,
    ),
  }
}

function isDecisionCandidate(path: string): boolean {
  if (isUnderDependencyVendorPath(path) || isConnectorMirrorPath(path))
    return false
  const base = (path.split("/").pop() ?? "").toLowerCase()
  if (base === "index.md" || base === "readme.md") return false
  if (base.includes("template")) return false
  return true
}

/**
 * Source-repository extractor for architecture decision records (ADR-033):
 * `Decision` nodes with `DECLARED_IN File` (via the link pass),
 * `Decision INFLUENCES Service` by location, `Decision SUPERSEDES Decision`,
 * and `Decision MENTIONS File` for backticked repo paths. Deterministic.
 */
export async function extractDecisions(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  if (shouldSkipCodeExtractorForPartialDiff(state)) return {}

  const globbed = await Promise.all(
    DECISION_GLOBS.map((pattern) =>
      globFiles(state.repositoryId, state.orgId, { pattern, onlyFiles: true }),
    ),
  )
  const candidates = [
    ...new Set(
      globbed.flatMap((result) =>
        result.entries
          .filter((entry) => entry.type === "file")
          .map((entry) => entry.path),
      ),
    ),
  ]
    .filter(isDecisionCandidate)
    .sort()
  const scanPaths = partialScanPathsForExtractors(state)
  const scopedPaths = (
    state.ingestMode === "partial" && scanPaths.length > 0
      ? filterPathsByPartialScan(candidates, scanPaths)
      : candidates
  ).slice(0, 500)
  if (scopedPaths.length === 0) return {}

  const contents = await fetchFiles(
    state.repositoryId,
    state.orgId,
    scopedPaths,
  )
  const packages = packageRootsFromObjects(state.extractedObjects ?? []).filter(
    (entry) => entry.repositoryId === state.repositoryId,
  )
  const rootServiceKey = `svc:${state.repositoryId}:./`
  const hasRootService = (state.extractedObjects ?? []).some(
    (object) =>
      object.kind === "Service" && object.deduplicationKey === rootServiceKey,
  )

  const decisions: Array<{
    path: string
    key: string
    parsed: ParsedDecision
  }> = []
  for (const path of scopedPaths) {
    const content = contents[path]
    if (!content) continue
    const parsed = parseDecisionMarkdown(content, path)
    if (!parsed) continue
    decisions.push({
      path,
      key: decisionDedupKey(state.repositoryId, path),
      parsed,
    })
  }
  const keyByAdrId = new Map<string, string>()
  for (const decision of decisions) {
    if (decision.parsed.adrId && !keyByAdrId.has(decision.parsed.adrId)) {
      keyByAdrId.set(decision.parsed.adrId, decision.key)
    }
  }

  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []
  const sourceId = (path: string, predicate: string, target: string) =>
    buildEvidenceSourceId({
      extractor: "decision",
      repositoryId: state.repositoryId,
      segments: [path, predicate, target],
      targetHash: state.targetHash,
    })
  const claim = (input: {
    subjectRef: string
    objectRef: string
    objectKind: string
    predicate: "INFLUENCES" | "SUPERSEDES" | "MENTIONS"
    path: string
    target: string
    confidence: number
  }): ExtractedClaim => ({
    subjectRef: input.subjectRef,
    subjectKind: "Decision",
    objectRef: input.objectRef,
    objectKind: input.objectKind,
    predicate: input.predicate,
    sourceId: sourceId(input.path, input.predicate, input.target),
    sourceType: "git",
    extractionMethod: "deterministic",
    confidence: input.confidence,
    provenance: { path: input.path },
  })

  for (const { path, key, parsed } of decisions) {
    objects.push({
      kind: "Decision",
      deduplicationKey: key,
      name: parsed.title.slice(0, 200),
      summary: parsed.summary.slice(0, 500),
      payload: {
        path,
        status: parsed.status,
        date: parsed.date,
        adr_id: parsed.adrId,
        excerpt: parsed.excerpt,
      },
    })

    const pkg = matchPackageForPath(path, packages)
    if (pkg?.kind === "Service") {
      claims.push(
        claim({
          subjectRef: key,
          objectRef: pkg.deduplicationKey,
          objectKind: "Service",
          predicate: "INFLUENCES",
          path,
          target: pkg.root,
          confidence: 0.9,
        }),
      )
    } else if (!pkg && hasRootService) {
      claims.push(
        claim({
          subjectRef: key,
          objectRef: rootServiceKey,
          objectKind: "Service",
          predicate: "INFLUENCES",
          path,
          target: "./",
          confidence: 0.9,
        }),
      )
    }

    for (const adrId of parsed.supersedes) {
      const target = keyByAdrId.get(adrId)
      if (target && target !== key) {
        claims.push(
          claim({
            subjectRef: key,
            objectRef: target,
            objectKind: "Decision",
            predicate: "SUPERSEDES",
            path,
            target: adrId,
            confidence: 0.9,
          }),
        )
      }
    }
    for (const adrId of parsed.supersededBy) {
      const successor = keyByAdrId.get(adrId)
      if (successor && successor !== key) {
        claims.push(
          claim({
            subjectRef: successor,
            objectRef: key,
            objectKind: "Decision",
            predicate: "SUPERSEDES",
            path,
            target: parsed.adrId ?? path,
            confidence: 0.9,
          }),
        )
      }
    }

    for (const mentioned of extractBacktickedPaths(parsed.excerpt)) {
      const located = asLocatedPath(mentioned)
      if (!located || located === path) continue
      claims.push(
        claim({
          subjectRef: key,
          objectRef: fileDedupKey(state.repositoryId, located),
          objectKind: "File",
          predicate: "MENTIONS",
          path,
          target: located,
          confidence: 0.8,
        }),
      )
    }
  }

  return { extractedObjects: objects, extractedClaims: claims }
}
