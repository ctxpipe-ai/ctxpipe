/**
 * Phase 1: extract InstructionUnit objects + HAS_INSTRUCTION claims from agent/docs files.
 * Phase 2: derive Skill objects + MEMBER_OF_PRIMARY when ≥2 compatible units (repo-local).
 *
 * Applicability is payload-only (envelope). SPECIALIZES deferred.
 */
import { createHash } from "node:crypto"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import slugify from "@sindresorhus/slugify"
import { z } from "zod/v3"
import { requireCurrentOrgId } from "../../../auth/context.js"
import {
  fetchFiles,
  listFilesRecursive,
} from "../../../domain/codeIngestion/codesearchClient.js"
import { langfusePipelineCallbacks } from "../../../observability/langfusePipelineMetrics.js"
import { getLogger } from "../../../observability/logger.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"
import { resolveSubmissionRoot } from "./extractionSubmissionRoot.js"
import {
  findScriptKeyLineRange,
  formatScriptInvocationLabel,
  inferPackageManagerFromPaths,
  inferScriptEnvironment,
  isStableScriptName,
  LATENT_SCRIPTS_CAP,
  latentDeterministicConfidence,
  latentScriptCanonicalString,
  looksDangerousScriptBody,
  parsePackageJsonScripts,
  truncateExcerpt,
} from "./packageJsonScriptsLatent.js"

const ModalitySchema = z.enum([
  "required",
  "recommended",
  "forbidden",
  "avoid",
  "optional",
])

/** Where the rule applies in the repo tree; omit if unknown (wildcard). */
const ApplicabilityScopeSchema = z
  .enum(["repository", "package", "path", "global"])
  .optional()

/** Runtime or pipeline context; omit if unknown (wildcard). */
const ApplicabilityEnvironmentSchema = z
  .enum(["ci", "local", "development", "staging", "production", "test"])
  .optional()

const ApplicabilityEnvelopeSchema = z.object({
  tags: z.array(z.string()),
  scope: ApplicabilityScopeSchema,
  environment: ApplicabilityEnvironmentSchema,
})

/** LLM output per file (one invocation per file, batched units). */
const LlmUnitsResponseSchema = z.object({
  units: z.array(
    z.object({
      name: z.string().min(1).max(200),
      summary: z.string().min(1).max(500),
      source_excerpt: z.string().min(1),
      modality: ModalitySchema,
      intent: z.string().min(1).max(400),
      applicability: ApplicabilityEnvelopeSchema,
      /** If false, treat as non-durable (skip InstructionUnit). */
      durable: z.boolean(),
    }),
  ),
})

export type InstructionModality = z.infer<typeof ModalitySchema>
export type ApplicabilityEnvelope = z.infer<typeof ApplicabilityEnvelopeSchema>
export type ApplicabilityScope = NonNullable<ApplicabilityEnvelope["scope"]>
export type ApplicabilityEnvironment = NonNullable<
  ApplicabilityEnvelope["environment"]
>

const EPHEMERAL_PATTERNS: RegExp[] = [
  /\bfor\s+now\b/i,
  /\btemporary\b/i,
  /\bTODO\s*:/i,
  /\bhack\b/i,
  /\buntil\s+we\s+migrate/i,
  /\bone-?off\b/i,
  /\blegacy\s+path\b/i,
]

export function looksEphemeral(text: string): boolean {
  return EPHEMERAL_PATTERNS.some((re) => re.test(text))
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32)
}

function instructionSourceTier(path: string): 1 | 2 | 3 {
  const p = path.toLowerCase()
  if (
    p.includes("/.cursor/rules/") ||
    p.endsWith("agents.md") ||
    p.endsWith("/agents.md") ||
    p.endsWith("claude.md") ||
    p.endsWith("/claude.md")
  ) {
    return 1
  }
  if (
    p.includes("/docs/") ||
    p.endsWith("contributing.md") ||
    p.endsWith("/contributing.md")
  ) {
    return 2
  }
  return 3
}

/**
 * MVP: path-priority (tier) is folded into this single scalar before claims are written.
 * Not passed separately into `aggregateConfidence` — see nodes/README.md (extractInstructionUnits).
 */
function tierBaseConfidence(tier: 1 | 2 | 3): number {
  switch (tier) {
    case 1:
      return 0.82
    case 2:
      return 0.72
    default:
      return 0.62
  }
}

function isInstructionCandidatePath(path: string): boolean {
  const p = path.toLowerCase()
  if (p.endsWith("agents.md")) return true
  if (p.endsWith("claude.md")) return true
  if (p.endsWith("contributing.md")) return true
  if (p.includes("/.cursor/rules/") && p.endsWith(".md")) return true
  if (p.endsWith("/readme.md") || p === "readme.md") return true
  return false
}

/** Stable identity for merge/idempotency: repo scope + path + root + excerpt bytes (not LLM name/summary). */
export function buildDedupKey(input: {
  repositoryId: string
  root: string
  path: string
  /** First 32 hex chars of SHA-256(UTF-8 source_excerpt); same as payload `content_hash`. */
  contentHash: string
}): string {
  const h = sha256Hex(
    `${input.repositoryId}:${input.path}:${input.root}:${input.contentHash}`,
  )
  return `inu:${input.repositoryId}:${input.root}:${h}`
}

/** Intent + tags only — buckets units before scope/environment wildcard merging. */
function skillGroupingKey(intent: string, env: ApplicabilityEnvelope): string {
  const tags = [...env.tags].map((t) => t.toLowerCase().trim()).sort()
  return `${slugify(intent.trim().toLowerCase())}|${tags.join(",")}`
}

/** Intent + tags + normalized scope/environment (for stable Skill id salt; member list disambiguates). */
function clusterCompatibilityKey(
  intent: string,
  env: ApplicabilityEnvelope,
): string {
  const tags = [...env.tags].map((t) => t.toLowerCase().trim()).sort()
  const scopePart = env.scope !== undefined ? env.scope.toLowerCase() : ""
  const environmentPart =
    env.environment !== undefined ? env.environment.toLowerCase() : ""
  return `${slugify(intent.trim().toLowerCase())}|${tags.join(",")}|${scopePart}|${environmentPart}`
}

/** When both sides set a field, values must match (case-insensitive); if either omits it, treat as wildcard. */
function optionalApplicabilityFieldCompatible(
  a: string | undefined,
  b: string | undefined,
): boolean {
  if (a === undefined || b === undefined) return true
  return a.toLowerCase() === b.toLowerCase()
}

export function envelopesCompatible(
  a: ApplicabilityEnvelope,
  b: ApplicabilityEnvelope,
): boolean {
  const ta = new Set(a.tags.map((t) => t.toLowerCase()))
  const tb = new Set(b.tags.map((t) => t.toLowerCase()))
  if (ta.size === 0 && tb.size === 0) {
    /* continue */
  } else if (ta.size === 0 || tb.size === 0) {
    return false
  } else {
    const [smaller, larger] = ta.size <= tb.size ? [ta, tb] : [tb, ta]
    for (const x of smaller) {
      if (!larger.has(x)) return false
    }
  }
  if (!optionalApplicabilityFieldCompatible(a.scope, b.scope)) return false
  if (!optionalApplicabilityFieldCompatible(a.environment, b.environment))
    return false
  return true
}

function getEnvelope(u: ExtractedObject): ApplicabilityEnvelope {
  const payload = u.payload as { applicability?: ApplicabilityEnvelope }
  return payload.applicability ?? { tags: [] }
}

/**
 * Split a same-intent+tags group into subclusters so every pair in a subcluster passes
 * {@link envelopesCompatible} (first-fit; stable order by deduplicationKey).
 */
function partitionByCompatibleEnvelope(
  members: ExtractedObject[],
): ExtractedObject[][] {
  const sorted = [...members].sort((a, b) =>
    (a.deduplicationKey ?? "").localeCompare(b.deduplicationKey ?? ""),
  )
  const clusters: ExtractedObject[][] = []
  for (const u of sorted) {
    const envU = getEnvelope(u)
    let placed = false
    for (const c of clusters) {
      if (c.every((m) => envelopesCompatible(getEnvelope(m), envU))) {
        c.push(u)
        placed = true
        break
      }
    }
    if (!placed) clusters.push([u])
  }
  return clusters
}

const MIN_UNITS_FOR_SKILL = 2
/** Reject skill promotion if any member is below this (uses payload.confidence or tier fallback). */
const MIN_MEMBER_CONFIDENCE_FOR_SKILL = 0.6
/** Negative vs positive normative polarity — do not merge across members without an explicit product flag. */
const MODALITY_NEGATIVE = new Set<InstructionModality>(["forbidden", "avoid"])
const MODALITY_POSITIVE = new Set<InstructionModality>([
  "required",
  "recommended",
  "optional",
])

type InstructionUnitPayload = {
  intent?: string
  applicability?: ApplicabilityEnvelope
  path?: string
  line_start?: number
  line_end?: number
  modality?: InstructionModality
  /** Phase 1: same scalar as HAS_INSTRUCTION claim (tier-based); used for promotion floor. */
  confidence?: number
  source_tier?: 1 | 2 | 3
}

function memberEffectiveConfidence(p: InstructionUnitPayload): number {
  if (typeof p.confidence === "number" && Number.isFinite(p.confidence)) {
    return p.confidence
  }
  return tierBaseConfidence(p.source_tier ?? 3)
}

function evidenceSpanKey(p: InstructionUnitPayload): string {
  const path = p.path ?? ""
  const ls = p.line_start ?? 0
  const le = p.line_end ?? 0
  return `${path}:${ls}:${le}`
}

/** At least two distinct (path, line_start, line_end) locations — blocks duplicate-span stuffing. */
function hasEvidenceDiversity(members: ExtractedObject[]): boolean {
  const keys = new Set<string>()
  for (const m of members) {
    keys.add(evidenceSpanKey(m.payload as InstructionUnitPayload))
  }
  return keys.size >= 2
}

function modalitiesPolarityConflict(members: ExtractedObject[]): boolean {
  let neg = false
  let pos = false
  for (const m of members) {
    const mod = (m.payload as InstructionUnitPayload).modality
    if (!mod) continue
    if (MODALITY_NEGATIVE.has(mod)) neg = true
    if (MODALITY_POSITIVE.has(mod)) pos = true
    if (neg && pos) return true
  }
  return false
}

function clusterPassesSkillPromotion(members: ExtractedObject[]): boolean {
  if (members.length < MIN_UNITS_FOR_SKILL) return false
  for (const m of members) {
    const c = memberEffectiveConfidence(m.payload as InstructionUnitPayload)
    if (c < MIN_MEMBER_CONFIDENCE_FOR_SKILL) return false
  }
  if (!hasEvidenceDiversity(members)) return false
  if (modalitiesPolarityConflict(members)) return false
  return true
}

async function extractUnitsFromFileContent(input: {
  path: string
  content: string
  repositoryId: string
  targetHash: string
}): Promise<z.infer<typeof LlmUnitsResponseSchema>> {
  const env = process.env.MODEL_PROVIDER_API_KEY
  if (!env || env.length === 0) {
    return { units: [] }
  }

  const model = getModel("medium", { temperature: 0.1 })
  const structured = model.withStructuredOutput(LlmUnitsResponseSchema, {
    name: "instruction_units",
  })

  const truncated =
    input.content.length > 48_000
      ? `${input.content.slice(0, 48_000)}\n\n[truncated]`
      : input.content

  const res = await structured.invoke(
    [
      new SystemMessage(`You extract atomic procedural instruction-units from repository documentation and agent rule files.

Rules:
- Each unit is one clear imperative or normative rule (do not merge distinct tools, e.g. keep pnpm vs bun separate).
- modality: required | recommended | forbidden | avoid | optional — normative strength only.
- intent: short purpose (what this accomplishes).
- applicability.tags: freeform hints (stack, area, tool) — payload only, not graph edges.
- applicability.scope (optional): repository | package | path | global — where the rule applies; omit if unclear.
- applicability.environment (optional): ci | local | development | staging | production | test — runtime or pipeline context; omit if unclear.
- durable: false for ephemeral/temporary/migration-only notes; true for stable norms.
- source_excerpt: copy the exact supporting lines from the file (verbatim).
- name + summary: may lightly clarify grammar; do not remove tool-specific tokens.`),
      new HumanMessage(
        `File path: ${input.path}\nrepositoryId: ${input.repositoryId}\ntargetHash: ${input.targetHash}\n\n---\n${truncated}`,
      ),
    ],
    {
      callbacks: langfusePipelineCallbacks({
        step: "codeIngestion.extractInstructionUnits.llm",
        dimensions: { repositoryId: input.repositoryId, path: input.path },
      }),
    },
  )

  return res
}

/**
 * Phase 1 + Phase 2 orchestration for instruction units and derived skills.
 */
export async function extractInstructionUnits(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  requireCurrentOrgId()
  const { repositoryId, orgId, roots = ["./"], targetHash } = state

  const allPaths = await listFilesRecursive(repositoryId, orgId)
  const candidates = allPaths.filter(isInstructionCandidatePath).slice(0, 40)
  const logger = getLogger()

  const latent = await extractLatentPackageJsonInstructionUnits({
    repositoryId,
    orgId,
    targetHash,
    roots,
    allPaths,
  })

  const contents =
    candidates.length > 0
      ? await fetchFiles(repositoryId, orgId, candidates)
      : {}

  const extractedObjects: ExtractedObject[] = [...latent.objects]
  const extractedClaims: ExtractedClaim[] = [...latent.claims]

  let filesSkippedEmpty = 0
  let filesSkippedRoot = 0
  let filesSkippedLlmError = 0
  let filesProcessed = 0

  for (const path of candidates) {
    const content = contents[path]
    if (!content || content.trim().length === 0) {
      filesSkippedEmpty++
      continue
    }

    const root = resolveSubmissionRoot(path, roots)
    if (root === null) {
      filesSkippedRoot++
      continue
    }

    let parsed: z.infer<typeof LlmUnitsResponseSchema>
    try {
      parsed = await extractUnitsFromFileContent({
        path,
        content,
        repositoryId,
        targetHash,
      })
    } catch {
      filesSkippedLlmError++
      continue
    }
    filesProcessed++

    const tier = instructionSourceTier(path)
    for (const u of parsed.units) {
      if (!u.durable) continue
      if (looksEphemeral(u.source_excerpt) || looksEphemeral(u.summary))
        continue

      const idx = content.indexOf(
        u.source_excerpt.slice(0, Math.min(80, u.source_excerpt.length)),
      )
      const prefix = idx >= 0 ? content.slice(0, idx) : ""
      const lineStart = prefix.split("\n").length
      const lineEnd = lineStart + u.source_excerpt.split("\n").length - 1

      const contentHash = sha256Hex(u.source_excerpt)
      const dedupKey = buildDedupKey({
        repositoryId,
        root,
        path,
        contentHash,
      })

      const svcKey = `svc:${repositoryId}:${root}`
      const confidence = tierBaseConfidence(tier)

      extractedObjects.push({
        kind: "InstructionUnit",
        deduplicationKey: dedupKey,
        name: u.name,
        summary: u.summary,
        payload: {
          source_excerpt: u.source_excerpt,
          path,
          root,
          line_start: lineStart,
          line_end: lineEnd,
          section_id: sha256Hex(`${path}:${lineStart}`),
          content_hash: contentHash,
          modality: u.modality,
          intent: u.intent,
          applicability: u.applicability,
          source_tier: tier,
          confidence,
          target_hash: targetHash,
        },
      })

      extractedClaims.push({
        subjectRef: svcKey,
        subjectKind: "Service",
        objectRef: dedupKey,
        objectKind: "InstructionUnit",
        predicate: "HAS_INSTRUCTION",
        sourceId: `extractInstructionUnits:${repositoryId}:${dedupKey}:${targetHash}`,
        sourceType: "git",
        extractionMethod: "llm",
        confidence,
        provenance: { path, root, tier },
      })
    }
  }

  const { objects: skillObjects, claims: skillClaims } = deriveSkillsFromUnits({
    repositoryId,
    targetHash,
    units: extractedObjects,
  })

  const instructionUnitsExtracted = extractedObjects.length
  const latentPackageJsonScripts = latent.objects.length
  const skillsDerived = skillObjects.length
  const filesSkipped =
    filesSkippedEmpty + filesSkippedRoot + filesSkippedLlmError

  logger.set({
    step: "codeIngestion.extractInstructionUnits",
    repositoryId,
    orgId,
    targetHash,
    candidateFiles: candidates.length,
    filesProcessed,
    filesSkipped,
    filesSkippedEmpty,
    filesSkippedRoot,
    filesSkippedLlmError,
    latentPackageJsonScripts,
    instructionUnitsExtracted,
    skillsDerived,
  })
  logger.info("extractInstructionUnits summary")

  return {
    extractedObjects: [...extractedObjects, ...skillObjects],
    extractedClaims: [...extractedClaims, ...skillClaims],
  }
}

function packageJsonPathForRoot(root: string): string {
  return root === "./" ? "package.json" : `${root}/package.json`
}

async function extractLatentPackageJsonInstructionUnits(input: {
  repositoryId: string
  orgId: string
  targetHash: string
  roots: string[]
  allPaths: string[]
}): Promise<{ objects: ExtractedObject[]; claims: ExtractedClaim[] }> {
  const { repositoryId, orgId, targetHash, roots, allPaths } = input
  const pm = inferPackageManagerFromPaths(allPaths)
  const pathsToFetch: string[] = []
  const rootByPath = new Map<string, string>()

  for (const root of roots) {
    const rel = packageJsonPathForRoot(root)
    if (!allPaths.includes(rel)) continue
    const resolved = resolveSubmissionRoot(rel, roots)
    if (resolved === null) continue
    pathsToFetch.push(rel)
    rootByPath.set(rel, resolved)
  }

  if (pathsToFetch.length === 0) {
    return { objects: [], claims: [] }
  }

  const contents = await fetchFiles(repositoryId, orgId, pathsToFetch)

  type Candidate = {
    path: string
    root: string
    scriptName: string
    body: string
  }
  const candidates: Candidate[] = []

  for (const path of pathsToFetch) {
    const root = rootByPath.get(path)
    if (root === undefined) continue
    const content = contents[path]
    if (!content || content.trim().length === 0) continue
    for (const { scriptName, body } of parsePackageJsonScripts(content)) {
      if (!isStableScriptName(scriptName)) continue
      if (looksDangerousScriptBody(body)) continue
      candidates.push({ path, root, scriptName, body })
    }
  }

  candidates.sort((a, b) => {
    const pr = a.path.localeCompare(b.path)
    if (pr !== 0) return pr
    return a.scriptName.localeCompare(b.scriptName)
  })

  const picked = candidates.slice(0, LATENT_SCRIPTS_CAP)

  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []

  for (const c of picked) {
    const content = contents[c.path] ?? ""
    const { lineStart, lineEnd } = findScriptKeyLineRange(content, c.scriptName)
    const canonical = latentScriptCanonicalString(c.root, c.scriptName, c.body)
    const contentHash = sha256Hex(canonical)
    const sourceExcerpt = truncateExcerpt(c.body)
    const dedupKey = buildDedupKey({
      repositoryId,
      root: c.root,
      path: c.path,
      contentHash,
    })

    const svcKey = `svc:${repositoryId}:${c.root}`
    const summary = formatScriptInvocationLabel(c.scriptName, pm)
    const intent = `Run workspace script \`${c.scriptName}\``
    const env = inferScriptEnvironment(c.scriptName)
    const applicability = {
      tags: ["package.json", "scripts"],
      ...(env !== undefined ? { environment: env } : {}),
    }

    const confidence = latentDeterministicConfidence(
      `${repositoryId}:${c.path}:${c.scriptName}`,
    )

    objects.push({
      kind: "InstructionUnit",
      deduplicationKey: dedupKey,
      name: summary,
      summary,
      payload: {
        source_excerpt: sourceExcerpt,
        path: c.path,
        root: c.root,
        line_start: lineStart,
        line_end: lineEnd,
        section_id: sha256Hex(`${c.path}:${lineStart}`),
        content_hash: contentHash,
        modality: "recommended",
        intent,
        applicability,
        source_tier: 3,
        confidence,
        target_hash: targetHash,
      },
    })

    claims.push({
      subjectRef: svcKey,
      subjectKind: "Service",
      objectRef: dedupKey,
      objectKind: "InstructionUnit",
      predicate: "HAS_INSTRUCTION",
      sourceId: `extractInstructionUnits:latent:${repositoryId}:${dedupKey}:${targetHash}`,
      sourceType: "git",
      extractionMethod: "deterministic",
      confidence,
      provenance: { path: c.path, root: c.root, tier: 3 },
    })
  }

  return { objects, claims }
}

export function deriveSkillsFromUnits(input: {
  repositoryId: string
  targetHash: string
  units: ExtractedObject[]
}): { objects: ExtractedObject[]; claims: ExtractedClaim[] } {
  const units = input.units.filter((o) => o.kind === "InstructionUnit")
  if (units.length < MIN_UNITS_FOR_SKILL) {
    return { objects: [], claims: [] }
  }

  const groups = new Map<string, ExtractedObject[]>()
  for (const u of units) {
    const payload = u.payload as {
      intent?: string
      applicability?: ApplicabilityEnvelope
    }
    const intent = payload.intent ?? u.summary ?? ""
    const env = getEnvelope(u)
    const key = skillGroupingKey(intent, env)
    const list = groups.get(key) ?? []
    list.push(u)
    groups.set(key, list)
  }

  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []

  for (const [, members] of groups) {
    if (members.length < MIN_UNITS_FOR_SKILL) continue

    const subclusters = partitionByCompatibleEnvelope(members)
    for (const sub of subclusters) {
      if (sub.length < MIN_UNITS_FOR_SKILL) continue
      if (!clusterPassesSkillPromotion(sub)) continue

      const head = sub[0]
      if (!head) continue

      const firstEnv = getEnvelope(head)
      const intent =
        (head.payload as { intent?: string })?.intent ?? head.summary ?? "Skill"
      const memberSig = sub
        .map((m) => m.deduplicationKey ?? "")
        .sort()
        .join(",")
      const skillSlug = sha256Hex(
        `${input.repositoryId}:${clusterCompatibilityKey(intent, firstEnv)}:${memberSig}`,
      ).slice(0, 16)
      const skillKey = `skl:${input.repositoryId}:${skillSlug}`

      objects.push({
        kind: "Skill",
        deduplicationKey: skillKey,
        name: intent.slice(0, 120),
        summary: `Derived skill (${sub.length} units)`,
        payload: {
          intent_summary: intent,
          repository_id: input.repositoryId,
          member_count: sub.length,
        },
      })

      const memberConfidences = sub.map((m) =>
        memberEffectiveConfidence(m.payload as InstructionUnitPayload),
      )
      const clusterConfidence = Math.min(...memberConfidences)

      for (const m of sub) {
        if (!m.deduplicationKey) continue
        claims.push({
          subjectRef: m.deduplicationKey,
          subjectKind: "InstructionUnit",
          objectRef: skillKey,
          objectKind: "Skill",
          predicate: "MEMBER_OF_PRIMARY",
          sourceId: `deriveSkills:${input.repositoryId}:${skillSlug}:${m.deduplicationKey}:${input.targetHash}`,
          sourceType: "git",
          extractionMethod: "deterministic",
          confidence: clusterConfidence,
          provenance: { skillKey, unitKey: m.deduplicationKey },
        })
      }
    }
  }

  return { objects, claims }
}
