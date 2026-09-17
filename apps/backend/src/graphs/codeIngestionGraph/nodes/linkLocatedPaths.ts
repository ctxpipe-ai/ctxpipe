import { and, eq, inArray, or, sql } from "drizzle-orm"
import { getOrgDb } from "../../../db/client.js"
import { objects } from "../../../db/schema/objects.js"
import { isConnectorMirrorPath } from "../../../domain/codeIngestion/connectorMirrorPaths.js"
import { buildEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import { parseGithubPullRequestUrl } from "../../../domain/codeIngestion/referenceResolver.js"
import { getLogger, log } from "../../../observability/logger.js"
import {
  type ExtractedClaim,
  type ExtractedObject,
  isIdRef,
} from "../schemas.js"
import { findMatchingRoot } from "./extractionSubmissionRoot.js"

export type PackageKind = "Service" | "App" | "Library"

export type PackageRoot = {
  kind: PackageKind
  repositoryId: string
  root: string
  deduplicationKey: string
}

const PACKAGE_KINDS = new Set<string>(["Service", "App", "Library"])

/** Kinds whose `payload.path` states where they are declared (`DECLARED_IN File`). */
const DECLARED_IN_KINDS = new Set<string>(["InstructionUnit", "Decision"])

/**
 * Reference-family predicates (ADR-033). Both ends must resolve to a node that
 * exists in this run or in the graph already; otherwise the claim is dropped by
 * {@link resolveReferenceClaims} instead of failing noisily in dedup.
 */
export const CROSS_REFERENCE_PREDICATES = new Set<string>([
  "REFERENCES",
  "MENTIONS",
  "SUPERSEDES",
  "OWNS",
  "INFLUENCES",
])

const LINEAR_TEAM_KEY_PREFIX = "team:linear:"
const DEDUP_LOOKUP_CHUNK = 500

export function fileDedupKey(scope: string, path: string): string {
  return `fil:${scope}:${path}`
}

/**
 * Repo-relative path used as File identity. Rejects HTTP routes, `..`,
 * and connector warehouse prefixes so PR extract and source extract join.
 */
export function asLocatedPath(value: unknown): string | null {
  if (typeof value !== "string") return null
  let path = value.replace(/\\/g, "/").trim()
  while (path.startsWith("./")) path = path.slice(2)
  if (path.length === 0 || path === ".") return null
  if (path.startsWith("/") || path.startsWith("../")) return null
  if (path.split("/").includes("..")) return null
  if (isConnectorMirrorPath(path)) return null
  return path
}

export function parsePackageDedupKey(key: string): PackageRoot | null {
  const match = /^(svc|app|lib):([^:]+):([^:]+)$/.exec(key)
  const repositoryId = match?.[2]
  const root = match?.[3]
  if (!match || !repositoryId || !root) return null
  const kind =
    match[1] === "app" ? "App" : match[1] === "lib" ? "Library" : "Service"
  return {
    kind,
    repositoryId,
    root,
    deduplicationKey: key,
  }
}

export function packageRootsFromObjects(
  extracted: ExtractedObject[],
): PackageRoot[] {
  const out: PackageRoot[] = []
  for (const object of extracted) {
    if (!PACKAGE_KINDS.has(object.kind)) continue
    const parsed = parsePackageDedupKey(object.deduplicationKey)
    if (!parsed) continue
    out.push({
      ...parsed,
      kind: object.kind as PackageKind,
    })
  }
  return out
}

export function matchPackageForPath(
  path: string,
  packages: PackageRoot[],
): PackageRoot | null {
  if (packages.length === 0) return null
  const root = findMatchingRoot(
    path,
    packages.map((entry) => entry.root),
  )
  if (root === null) return null
  return packages.find((entry) => entry.root === root) ?? null
}

export async function listPackageRootsForRepository(input: {
  orgId: string
  repositoryId: string
}): Promise<PackageRoot[]> {
  try {
    const db = getOrgDb()
    const rows = await db
      .select({
        kind: objects.kind,
        deduplicationKey: objects.deduplicationKey,
      })
      .from(objects)
      .where(
        and(
          eq(objects.orgId, input.orgId),
          inArray(objects.kind, ["Service", "App", "Library"]),
          or(
            sql`starts_with(${objects.deduplicationKey}, ${`svc:${input.repositoryId}:`})`,
            sql`starts_with(${objects.deduplicationKey}, ${`app:${input.repositoryId}:`})`,
            sql`starts_with(${objects.deduplicationKey}, ${`lib:${input.repositoryId}:`})`,
          ),
        ),
      )
    const out: PackageRoot[] = []
    for (const row of rows) {
      if (!row.deduplicationKey) continue
      if (!PACKAGE_KINDS.has(row.kind)) continue
      const parsed = parsePackageDedupKey(row.deduplicationKey)
      if (!parsed || parsed.repositoryId !== input.repositoryId) continue
      out.push({
        ...parsed,
        kind: row.kind as PackageKind,
      })
    }
    return out
  } catch {
    return []
  }
}

/** Linear team keys already on the graph (`team:linear:ENG` → `ENG`); bounds bare-identifier matching. */
export async function listLinearTeamKeys(orgId: string): Promise<string[]> {
  try {
    const db = getOrgDb()
    const rows = await db
      .select({ deduplicationKey: objects.deduplicationKey })
      .from(objects)
      .where(
        and(
          eq(objects.orgId, orgId),
          eq(objects.kind, "Team"),
          sql`starts_with(${objects.deduplicationKey}, ${LINEAR_TEAM_KEY_PREFIX})`,
        ),
      )
    return rows
      .map((row) => row.deduplicationKey?.slice(LINEAR_TEAM_KEY_PREFIX.length))
      .filter((key): key is string => Boolean(key))
  } catch {
    return []
  }
}

/** Works inside a request / workflow logger scope and outside it (post-concat hook). */
function logLinkPass(
  level: "info" | "warn",
  message: string,
  fields: Record<string, unknown>,
): void {
  try {
    const logger = getLogger()
    logger.set(fields)
    if (level === "warn") logger.warn(message)
    else logger.info(message)
    return
  } catch {
    // no scoped logger; fall through to the module logger
  }
  const event = { message, ...fields }
  if (level === "warn") log.warn(event)
  else log.info(event)
}

function claimTripleKey(
  claim: Pick<ExtractedClaim, "subjectRef" | "predicate" | "objectRef">,
): string {
  return `${claim.subjectRef}|${claim.predicate}|${claim.objectRef}`
}

function lastKeySegment(deduplicationKey: string): string {
  const segment = deduplicationKey.split(":").pop()
  return segment && segment.length > 0 ? segment : deduplicationKey
}

/**
 * After extractors run, locate every this-repo path on a File node:
 * `File PART_OF Repository`, `File PART_OF Service|App|Library` and
 * `InstructionUnit|Decision DECLARED_IN File` (ADR-032, ADR-033).
 * Returns only the additional objects/claims (reducer-safe).
 */
export function linkLocatedPaths(input: {
  repositoryId: string
  targetHash: string
  objects: ExtractedObject[]
  claims: ExtractedClaim[]
}): {
  extractedObjects: ExtractedObject[]
  extractedClaims: ExtractedClaim[]
} {
  const packages = packageRootsFromObjects(input.objects).filter(
    (entry) => entry.repositoryId === input.repositoryId,
  )
  const existingFileKeys = new Set(
    input.objects
      .filter((object) => object.kind === "File")
      .map((object) => object.deduplicationKey),
  )
  const existingTriples = new Set(input.claims.map(claimTripleKey))

  const paths = new Set<string>()
  for (const object of input.objects) {
    if (!DECLARED_IN_KINDS.has(object.kind)) continue
    const path = asLocatedPath(object.payload?.path)
    if (path) paths.add(path)
  }
  for (const claim of input.claims) {
    const path = asLocatedPath(claim.provenance?.path)
    if (path) paths.add(path)
    const configPath = asLocatedPath(claim.provenance?.configPath)
    if (configPath) paths.add(configPath)
  }

  const extractedObjects: ExtractedObject[] = []
  const extractedClaims: ExtractedClaim[] = []

  const pushClaim = (claim: ExtractedClaim) => {
    const key = claimTripleKey(claim)
    if (existingTriples.has(key)) return
    existingTriples.add(key)
    extractedClaims.push(claim)
  }

  const sourceId = (segments: string[]) =>
    buildEvidenceSourceId({
      extractor: "linkLocatedPaths",
      repositoryId: input.repositoryId,
      segments,
      targetHash: input.targetHash,
    })

  for (const path of paths) {
    const fileKey = fileDedupKey(input.repositoryId, path)
    if (!existingFileKeys.has(fileKey)) {
      existingFileKeys.add(fileKey)
      extractedObjects.push({
        kind: "File",
        deduplicationKey: fileKey,
        name: path,
        summary: `File at ${path}`,
        payload: { path },
      })
    }

    pushClaim({
      subjectRef: fileKey,
      subjectKind: "File",
      objectRef: input.repositoryId,
      objectKind: "Repository",
      predicate: "PART_OF",
      sourceId: sourceId(["file", path, "PART_OF", "repository"]),
      sourceType: "git",
      extractionMethod: "deterministic",
      confidence: 0.95,
      provenance: { path },
    })

    const pkg = matchPackageForPath(path, packages)
    if (pkg) {
      pushClaim({
        subjectRef: fileKey,
        subjectKind: "File",
        objectRef: pkg.deduplicationKey,
        objectKind: pkg.kind,
        predicate: "PART_OF",
        sourceId: sourceId(["file", path, "PART_OF", "package", pkg.root]),
        sourceType: "git",
        extractionMethod: "deterministic",
        confidence: 0.95,
        provenance: { path, root: pkg.root },
      })
    }
  }

  for (const object of input.objects) {
    if (!DECLARED_IN_KINDS.has(object.kind)) continue
    const path = asLocatedPath(object.payload?.path)
    if (!path) continue
    pushClaim({
      subjectRef: object.deduplicationKey,
      subjectKind: object.kind,
      objectRef: fileDedupKey(input.repositoryId, path),
      objectKind: "File",
      predicate: "DECLARED_IN",
      sourceId: sourceId([
        object.kind,
        "DECLARED_IN",
        path,
        lastKeySegment(object.deduplicationKey),
      ]),
      sourceType: "git",
      extractionMethod: "deterministic",
      confidence: 0.95,
      provenance: { path },
    })
  }

  return { extractedObjects, extractedClaims }
}

export type ReferenceResolutionSummary = Record<
  string,
  { kept: number; dropped: number; stubbed: number }
>

const STUB_PULL_REQUEST_KEY = /^prq:(repo_[A-Za-z0-9]+):(\d+)$/
const STUB_ISSUE_KEY = /^iss:linear:([A-Z][A-Z0-9]{0,9}-\d+)$/

/**
 * A reference to a pull request of a *connected* repository, or to a Linear
 * issue of a known team, has an identity fully determined by its key. Create a
 * stub node so the edge lands now; the mirror or the Linear sync enriches it
 * later (`inferredFromReference` payloads never clobber real ones).
 */
function stubForReference(
  ref: string,
  provenance: Record<string, unknown> | undefined,
): ExtractedObject | null {
  const pull = STUB_PULL_REQUEST_KEY.exec(ref)
  if (pull?.[2]) {
    const url = typeof provenance?.url === "string" ? provenance.url : undefined
    const repository = url
      ? parseGithubPullRequestUrl(url)?.repository
      : undefined
    const number = Number(pull[2])
    return {
      kind: "PullRequest",
      deduplicationKey: ref,
      name: repository ? `${repository}#${number}` : `pull request #${number}`,
      summary: "Referenced pull request (not mirrored yet)",
      payload: {
        number,
        ...(repository ? { repository } : {}),
        ...(url ? { url } : {}),
        inferredFromReference: true,
      },
    }
  }
  const issue = STUB_ISSUE_KEY.exec(ref)
  if (issue?.[1]) {
    return {
      kind: "Issue",
      deduplicationKey: ref,
      name: issue[1],
      summary: "Referenced issue (not mirrored yet)",
      payload: { identifier: issue[1], inferredFromReference: true },
    }
  }
  return null
}

/**
 * Drop reference-family claims whose subject or object is neither an object of
 * this run nor an existing graph object (looked up by deduplication key).
 * Run once after all roots are concatenated; sibling roots' objects are not in
 * the database yet on a first ingest.
 */
export async function resolveReferenceClaims(input: {
  orgId: string
  objects: ExtractedObject[]
  claims: ExtractedClaim[]
}): Promise<{
  claims: ExtractedClaim[]
  summary: ReferenceResolutionSummary
  /** Stub nodes created for references whose identity is known but not yet mirrored. */
  stubs: ExtractedObject[]
}> {
  const known = new Set(input.objects.map((object) => object.deduplicationKey))
  const candidates = input.claims.filter((claim) =>
    CROSS_REFERENCE_PREDICATES.has(claim.predicate),
  )
  const summary: ReferenceResolutionSummary = {}
  const stubs: ExtractedObject[] = []
  if (candidates.length === 0) return { claims: input.claims, summary, stubs }

  const unknownRefs = new Set<string>()
  for (const claim of candidates) {
    for (const ref of [claim.subjectRef, claim.objectRef]) {
      if (!isIdRef(ref) && !known.has(ref)) unknownRefs.add(ref)
    }
  }

  if (unknownRefs.size > 0) {
    try {
      const db = getOrgDb()
      const refs = [...unknownRefs]
      for (let i = 0; i < refs.length; i += DEDUP_LOOKUP_CHUNK) {
        const chunk = refs.slice(i, i + DEDUP_LOOKUP_CHUNK)
        const rows = await db
          .select({ deduplicationKey: objects.deduplicationKey })
          .from(objects)
          .where(
            and(
              eq(objects.orgId, input.orgId),
              inArray(objects.deduplicationKey, chunk),
            ),
          )
        for (const row of rows) {
          if (row.deduplicationKey) known.add(row.deduplicationKey)
        }
      }
    } catch (error) {
      logLinkPass("warn", "resolveReferenceClaims: graph lookup failed", {
        orgId: input.orgId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const resolvable = (ref: string) => isIdRef(ref) || known.has(ref)
  const stubOrNull = (ref: string, claim: ExtractedClaim): boolean => {
    if (resolvable(ref)) return true
    const stub = stubForReference(ref, claim.provenance)
    if (!stub) return false
    stubs.push(stub)
    known.add(stub.deduplicationKey)
    return true
  }
  const kept: ExtractedClaim[] = []
  for (const claim of input.claims) {
    if (!CROSS_REFERENCE_PREDICATES.has(claim.predicate)) {
      kept.push(claim)
      continue
    }
    const entry = summary[claim.predicate] ?? {
      kept: 0,
      dropped: 0,
      stubbed: 0,
    }
    summary[claim.predicate] = entry
    const stubsBefore = stubs.length
    if (
      stubOrNull(claim.subjectRef, claim) &&
      stubOrNull(claim.objectRef, claim)
    ) {
      entry.kept += 1
      entry.stubbed += stubs.length - stubsBefore
      kept.push(claim)
    } else {
      entry.dropped += 1
    }
  }

  logLinkPass("info", "link pass: reference claims resolved", {
    step: "codeIngestion.linkPass.references",
    orgId: input.orgId,
    referenceSummary: summary,
  })

  return { claims: kept, summary, stubs }
}

/** LangGraph node: additions only (concat reducer). Reference filtering happens in the workflow. */
export function linkLocatedPathsNode(state: {
  repositoryId: string
  targetHash: string
  extractedObjects?: ExtractedObject[]
  extractedClaims?: ExtractedClaim[]
}): {
  extractedObjects: ExtractedObject[]
  extractedClaims: ExtractedClaim[]
} {
  return linkLocatedPaths({
    repositoryId: state.repositoryId,
    targetHash: state.targetHash,
    objects: state.extractedObjects ?? [],
    claims: state.extractedClaims ?? [],
  })
}
