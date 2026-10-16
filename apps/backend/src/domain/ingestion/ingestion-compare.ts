import {
  hydrateKnowledgeTree,
  resolveHydrateLink,
} from "../workspaces/hydrate.js"
import { parseSimpleFrontMatter } from "../workspaces/layout.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"

/*
 * The shadow comparison of ingestion (CTX-584 T20, ADR-052). It compares the
 * extracted files that the old pipeline published with the files on the
 * assembled shadow ref of an ingestion v2 run for the same source SHA.
 *
 * The report below is a stable contract. T21 (publish from the ref) and T22
 * (ownership migration) read `exit.ready` and the counts. Add fields only;
 * a change to the meaning of a field needs a new `version`.
 */

export const INGESTION_COMPARISON_VERSION = 1

/** `generated_by` of a file that the old pipeline wrote. */
export const OLD_GENERATED_BY = "ctxpipe"
/** `generated_by` of a file that ingestion v2 wrote. */
export const SHADOW_GENERATED_BY = "ctxpipe-extract"

/** The phase 3 exit criteria of the CTX-584 plan. */
export const INGESTION_EXIT_THRESHOLDS = {
  unitRecall: 0.9,
  claimRecall: 0.9,
  rejectRate: 0.05,
  injectionsThrough: 0,
} as const

export type UnitRef = { kind: string; name: string; path: string }
export type ClaimRef = {
  /** The unit key of the subject (`<kind>/<name>`, normalized). */
  subject: string
  predicate: string
  /** The unit key of the object, or `ref:<path>` when no unit has that path. */
  object: string
  path: string
}

export type Coverage = {
  old: number
  shadow: number
  matched: number
  /** matched / old; null when the old pipeline has nothing. */
  recall: number | null
}

export type InjectionHit = { path: string; payloadId: string }

export type WorkspaceComparison = {
  workspaceId: string
  oldCommit: string
  /** The assembled ref tip; null when assemble did not finish. */
  shadowTip: string | null
  units: Coverage & {
    missing: UnitRef[]
    extra: UnitRef[]
    /** The same name with another kind: a classification difference. */
    kindChanges: Array<{ name: string; oldKind: string; shadowKind: string }>
    byKind: Record<string, Omit<Coverage, "recall">>
  }
  claims: Coverage & {
    missing: ClaimRef[]
    extra: ClaimRef[]
    byPredicate: Record<string, Omit<Coverage, "recall">>
  }
  quality: {
    ops: number
    rejects: number
    /** rejects / (ops + rejects); null when the run staged nothing. */
    rejectRate: number | null
    partial: number
    refused: string | null
    unitsWithoutClaims: number
    claimEvidence: { script: number; model: number; none: number }
    injectionScanned: boolean
    injectionsThrough: InjectionHit[]
  }
}

export type LabelCoverage = {
  expected: number
  old: number
  shadow: number
}

export type RunComparison = {
  shadowRunId: string
  oldRunId: string | null
  sourceUrl: string
  sha: string
  status: string
  durationMs: { old: number | null; shadow: number | null }
  costUsd: { old: number | null; shadow: number | null }
  revisionGaps?: Array<{
    workspaceId: string
    field: "oldPublished" | "shadowBase"
    resolvedByOverride: boolean
  }>
  workspaces: WorkspaceComparison[]
  /** Present when a label set names this source. */
  labels: { units: LabelCoverage; claims: LabelCoverage } | null
}

export type ExitCriterionId =
  | "unit_recall"
  | "claim_recall"
  | "reject_rate"
  | "injections"
  | "cost"
  | "p95_time"

export type ExitCriterion = {
  id: ExitCriterionId
  /** `unknown` when the data is not there; `unknown` is not a pass. */
  status: "pass" | "fail" | "unknown"
  actual: number | null
  /** For cost and time: the old pipeline's value. */
  threshold: number | null
}

export type IngestionComparisonReport = {
  version: typeof INGESTION_COMPARISON_VERSION
  generatedAt: string
  runs: RunComparison[]
  totals: {
    units: Coverage
    claims: Coverage
    ops: number
    rejects: number
    rejectRate: number | null
    injectionsThrough: number
    p95Ms: { old: number | null; shadow: number | null }
    costUsd: { old: number | null; shadow: number | null }
    labels: { units: LabelCoverage; claims: LabelCoverage } | null
  }
  exit: { ready: boolean; criteria: ExitCriterion[] }
}

/** A labeled set: what a correct run on a public repository finds. */
export type IngestionLabelSet = {
  sourceUrl: string
  units: Array<{ kind: string; name: string }>
  claims: Array<{
    subject: { kind: string; name: string }
    predicate: string
    object: { kind: string; name: string }
  }>
}

/** A payload of the injection fixtures. Its text must not be in an extracted file. */
export type InjectionPayload = { id: string; text: string }

export type ExtractedUnit = UnitRef & {
  key: string
  body: string
  summary: string | null
  claims: Array<ClaimRef & { evidence: "script" | "model" | null }>
}

export type ExtractedProjection = { units: ExtractedUnit[] }

export function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
}

export function unitKey(kind: string, name: string): string {
  return `${normalizeName(kind)}/${normalizeName(name)}`
}

function claimKey(claim: Pick<ClaimRef, "subject" | "predicate" | "object">) {
  return `${claim.subject}|${claim.predicate.toUpperCase()}|${claim.object}`
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function sourceMarker(value: string): string {
  return normalizeWorkspaceRepositoryUrl(value.split("#")[0] ?? value)
}

/**
 * The extracted units of one tree, as hydrate reads them. `generatedBy`
 * picks the pipeline. `changedPaths` selects run output regardless of ownership.
 * With `sourcePath`, a v2 unit must list that source file path in `sources`
 * (ADR-050 revision 2026-10-16). With `sourceUrl`, an old unit must name the
 * source in `source` or a claim, and each old claim must name it.
 */
export function projectExtractedTree(input: {
  files: ReadonlyArray<{ path: string; content: string }>
  generatedBy?: typeof OLD_GENERATED_BY | typeof SHADOW_GENERATED_BY
  changedPaths?: ReadonlySet<string>
  sourceUrl?: string
  sourcePath?: string
}): ExtractedProjection {
  const { units } = hydrateKnowledgeTree({
    workspaceId: "compare",
    files: input.files,
  })
  const attributes = new Map<string, Record<string, unknown>>()
  for (const file of input.files) {
    const parsed = parseSimpleFrontMatter(file.content)
    if (!parsed.malformed)
      attributes.set(file.path.replace(/^\/+/, ""), parsed.attributes)
  }
  const nameOf = (path: string, title: string | null) =>
    text(attributes.get(path)?.name) ??
    title ??
    (path.split("/").pop() ?? path).replace(/\.md$/, "")
  const keyByPath = new Map(
    units.map((unit) => [
      unit.path,
      unitKey(unit.kind ?? "", nameOf(unit.path, unit.title)),
    ]),
  )
  const source = input.sourceUrl ? sourceMarker(input.sourceUrl) : null

  const extracted: ExtractedUnit[] = []
  for (const unit of units) {
    const attrs = attributes.get(unit.path) ?? {}
    if (input.changedPaths) {
      if (!input.changedPaths.has(unit.path)) continue
    } else if (attrs.generated_by !== input.generatedBy) continue
    const rawClaims = Array.isArray(attrs.claims)
      ? (attrs.claims as unknown[]).filter(
          (c): c is Record<string, unknown> => !!c && typeof c === "object",
        )
      : []
    if (input.generatedBy === SHADOW_GENERATED_BY && input.sourcePath) {
      const sources = Array.isArray(attrs.sources) ? attrs.sources : []
      if (
        !sources.some(
          (s) => typeof s === "string" && s.trim() === input.sourcePath,
        )
      )
        continue
    } else if (source && input.generatedBy !== SHADOW_GENERATED_BY) {
      const markers = [attrs.source, ...rawClaims.map((c) => c.source)]
        .map(text)
        .filter((m): m is string => m !== null)
      if (!markers.some((m) => sourceMarker(m) === source)) continue
    }
    const kind = unit.kind ?? ""
    const name = nameOf(unit.path, unit.title)
    const key = unitKey(kind, name)
    const dir = unit.path.split("/").slice(0, -1).join("/")
    const claims: ExtractedUnit["claims"] = []
    for (const raw of rawClaims) {
      if (source && input.generatedBy === OLD_GENERATED_BY) {
        const claimSource = text(raw.source)
        if (!claimSource || sourceMarker(claimSource) !== source) continue
      }
      const to = text(raw.to)
      if (!to) continue
      const target = resolveHydrateLink(dir, to)
      const evidence =
        raw.evidence && typeof raw.evidence === "object"
          ? (raw.evidence as Record<string, unknown>).kind
          : undefined
      claims.push({
        subject: key,
        predicate: (text(raw.predicate) ?? "LINKS_TO").toUpperCase(),
        object: keyByPath.get(target) ?? `ref:${target || to}`,
        path: unit.path,
        evidence:
          evidence === "script" || evidence === "model" ? evidence : null,
      })
    }
    extracted.push({
      kind,
      name,
      path: unit.path,
      key,
      body: unit.body,
      summary: text(attrs.summary),
      claims,
    })
  }
  return { units: extracted }
}

function coverage(old: number, shadow: number, matched: number): Coverage {
  return { old, shadow, matched, recall: old === 0 ? null : matched / old }
}

function bucket(
  rows: ReadonlyArray<{ group: string; side: "old" | "shadow" | "both" }>,
): Record<string, Omit<Coverage, "recall">> {
  const out: Record<string, Omit<Coverage, "recall">> = {}
  for (const row of rows) {
    const entry = out[row.group] ?? { old: 0, shadow: 0, matched: 0 }
    out[row.group] = entry
    if (row.side !== "shadow") entry.old++
    if (row.side !== "old") entry.shadow++
    if (row.side === "both") entry.matched++
  }
  return out
}

function firstByKey<T extends { key: string }>(items: readonly T[]) {
  const map = new Map<string, T>()
  for (const item of items) if (!map.has(item.key)) map.set(item.key, item)
  return map
}

/** Text outside fenced code and block quotes, whitespace normalized. */
function plainText(markdown: string): string {
  let fenced = false
  const lines: string[] = []
  for (const line of markdown.split("\n")) {
    if (/^ {0,3}(?:```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced || /^ {0,3}>/.test(line)) continue
    lines.push(line)
  }
  return lines.join(" ").replace(/\s+/g, " ").toLowerCase()
}

/**
 * Finds the injection payloads that are in a v2 file as plain text. A payload
 * in a block quote or code is quoted data (ADR-052 section 5), not a hit.
 */
export function findInjectionsThrough(
  units: readonly ExtractedUnit[],
  payloads: readonly InjectionPayload[],
): InjectionHit[] {
  const hits: InjectionHit[] = []
  for (const unit of units) {
    const plain = plainText(`${unit.summary ?? ""}\n${unit.body}`)
    for (const payload of payloads) {
      const needle = payload.text.replace(/\s+/g, " ").trim().toLowerCase()
      if (needle && plain.includes(needle))
        hits.push({ path: unit.path, payloadId: payload.id })
    }
  }
  return hits
}

/** Compares the two projections of one Workspace. */
export function compareWorkspace(input: {
  workspaceId: string
  oldCommit: string
  shadowTip: string | null
  old: ExtractedProjection
  shadow: ExtractedProjection
  run: { ops: number; rejects: number; partial: number; refused?: string }
  injectionPayloads?: readonly InjectionPayload[]
}): WorkspaceComparison {
  const oldUnits = firstByKey(input.old.units)
  const shadowUnits = firstByKey(input.shadow.units)
  const ref = (u: ExtractedUnit): UnitRef => ({
    kind: u.kind,
    name: u.name,
    path: u.path,
  })
  const missing = [...oldUnits.values()].filter((u) => !shadowUnits.has(u.key))
  const extra = [...shadowUnits.values()].filter((u) => !oldUnits.has(u.key))
  const extraByName = new Map(extra.map((u) => [normalizeName(u.name), u]))
  const kindChanges = missing.flatMap((u) => {
    const other = extraByName.get(normalizeName(u.name))
    return other
      ? [{ name: u.name, oldKind: u.kind, shadowKind: other.kind }]
      : []
  })
  const unitRows = [
    ...[...oldUnits.values()].map((u) => ({
      group: normalizeName(u.kind),
      side: shadowUnits.has(u.key) ? ("both" as const) : ("old" as const),
    })),
    ...extra.map((u) => ({
      group: normalizeName(u.kind),
      side: "shadow" as const,
    })),
  ]

  const claimsOf = (p: ExtractedProjection) => {
    const map = new Map<string, ClaimRef>()
    for (const unit of p.units)
      for (const c of unit.claims) {
        const key = claimKey(c)
        if (!map.has(key))
          map.set(key, {
            subject: c.subject,
            predicate: c.predicate,
            object: c.object,
            path: c.path,
          })
      }
    return map
  }
  const oldClaims = claimsOf(input.old)
  const shadowClaims = claimsOf(input.shadow)
  const missingClaims = [...oldClaims].filter(([k]) => !shadowClaims.has(k))
  const extraClaims = [...shadowClaims].filter(([k]) => !oldClaims.has(k))
  const claimRows = [
    ...[...oldClaims].map(([k, c]) => ({
      group: c.predicate,
      side: shadowClaims.has(k) ? ("both" as const) : ("old" as const),
    })),
    ...extraClaims.map(([, c]) => ({
      group: c.predicate,
      side: "shadow" as const,
    })),
  ]

  const evidence = { script: 0, model: 0, none: 0 }
  for (const unit of input.shadow.units)
    for (const c of unit.claims) evidence[c.evidence ?? "none"]++
  const staged = input.run.ops + input.run.rejects

  return {
    workspaceId: input.workspaceId,
    oldCommit: input.oldCommit,
    shadowTip: input.shadowTip,
    units: {
      ...coverage(
        oldUnits.size,
        shadowUnits.size,
        oldUnits.size - missing.length,
      ),
      missing: missing.map(ref),
      extra: extra.map(ref),
      kindChanges,
      byKind: bucket(unitRows),
    },
    claims: {
      ...coverage(
        oldClaims.size,
        shadowClaims.size,
        oldClaims.size - missingClaims.length,
      ),
      missing: missingClaims.map(([, c]) => c),
      extra: extraClaims.map(([, c]) => c),
      byPredicate: bucket(claimRows),
    },
    quality: {
      ops: input.run.ops,
      rejects: input.run.rejects,
      rejectRate: staged === 0 ? null : input.run.rejects / staged,
      partial: input.run.partial,
      refused: input.run.refused ?? null,
      unitsWithoutClaims: input.shadow.units.filter((u) => !u.claims.length)
        .length,
      claimEvidence: evidence,
      injectionScanned:
        input.shadow.units.length > 0 &&
        !!input.injectionPayloads?.some((payload) => payload.text.trim()),
      injectionsThrough: findInjectionsThrough(
        input.shadow.units,
        input.injectionPayloads ?? [],
      ),
    },
  }
}

/** How many labeled units and claims each pipeline found in a run. */
export function labelCoverage(
  labels: IngestionLabelSet,
  old: readonly ExtractedProjection[],
  shadow: readonly ExtractedProjection[],
): { units: LabelCoverage; claims: LabelCoverage } {
  const unitKeys = (ps: readonly ExtractedProjection[]) =>
    new Set(ps.flatMap((p) => p.units.map((u) => u.key)))
  const claimKeys = (ps: readonly ExtractedProjection[]) =>
    new Set(ps.flatMap((p) => p.units.flatMap((u) => u.claims.map(claimKey))))
  const expectedUnits = new Set(
    labels.units.map((u) => unitKey(u.kind, u.name)),
  )
  const expectedClaims = new Set(
    labels.claims.map((c) =>
      claimKey({
        subject: unitKey(c.subject.kind, c.subject.name),
        predicate: c.predicate,
        object: unitKey(c.object.kind, c.object.name),
      }),
    ),
  )
  const found = (expected: Set<string>, got: Set<string>) =>
    [...expected].filter((k) => got.has(k)).length
  return {
    units: {
      expected: expectedUnits.size,
      old: found(expectedUnits, unitKeys(old)),
      shadow: found(expectedUnits, unitKeys(shadow)),
    },
    claims: {
      expected: expectedClaims.size,
      old: found(expectedClaims, claimKeys(old)),
      shadow: found(expectedClaims, claimKeys(shadow)),
    },
  }
}

/** Nearest-rank p95; null for no values. */
export function p95(values: readonly number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? null
}

function sumCoverage(items: readonly Coverage[]): Coverage {
  const old = items.reduce((s, c) => s + c.old, 0)
  const shadow = items.reduce((s, c) => s + c.shadow, 0)
  const matched = items.reduce((s, c) => s + c.matched, 0)
  return coverage(old, shadow, matched)
}

/** Sums one side over the runs; null when a run has no value for it. */
function sumKnown(values: ReadonlyArray<number | null>): number | null {
  if (!values.length || values.some((v) => v === null)) return null
  return (values as number[]).reduce((s, v) => s + v, 0)
}

function atLeast(
  actual: number | null,
  threshold: number,
): ExitCriterion["status"] {
  return actual === null ? "unknown" : actual >= threshold ? "pass" : "fail"
}

function noWorse(
  shadow: number | null,
  old: number | null,
): ExitCriterion["status"] {
  return shadow === null || old === null
    ? "unknown"
    : shadow <= old
      ? "pass"
      : "fail"
}

/** The totals and the phase 3 exit decision over all compared runs. */
export function buildComparisonReport(
  runs: RunComparison[],
  now: Date = new Date(),
): IngestionComparisonReport {
  const workspaces = runs.flatMap((r) => r.workspaces)
  const units = sumCoverage(workspaces.map((w) => w.units))
  const claims = sumCoverage(workspaces.map((w) => w.claims))
  const ops = workspaces.reduce((s, w) => s + w.quality.ops, 0)
  const rejects = workspaces.reduce((s, w) => s + w.quality.rejects, 0)
  const rejectRate = ops + rejects === 0 ? null : rejects / (ops + rejects)
  const injectionsThrough = workspaces.reduce(
    (s, w) => s + w.quality.injectionsThrough.length,
    0,
  )
  const injectionScanned =
    workspaces.length > 0 && workspaces.every((w) => w.quality.injectionScanned)
  const known = (v: number | null): v is number => v !== null
  const p95Ms = {
    old: p95(runs.map((r) => r.durationMs.old).filter(known)),
    shadow: p95(runs.map((r) => r.durationMs.shadow).filter(known)),
  }
  const costUsd = {
    old: sumKnown(runs.map((r) => r.costUsd.old)),
    shadow: sumKnown(runs.map((r) => r.costUsd.shadow)),
  }
  const labeled = runs.flatMap((r) => (r.labels ? [r.labels] : []))
  const addLabels = (pick: (l: (typeof labeled)[number]) => LabelCoverage) => ({
    expected: labeled.reduce((s, l) => s + pick(l).expected, 0),
    old: labeled.reduce((s, l) => s + pick(l).old, 0),
    shadow: labeled.reduce((s, l) => s + pick(l).shadow, 0),
  })
  const t = INGESTION_EXIT_THRESHOLDS
  const criteria: ExitCriterion[] = [
    {
      id: "unit_recall",
      status: atLeast(units.recall, t.unitRecall),
      actual: units.recall,
      threshold: t.unitRecall,
    },
    {
      id: "claim_recall",
      status: atLeast(claims.recall, t.claimRecall),
      actual: claims.recall,
      threshold: t.claimRecall,
    },
    {
      id: "reject_rate",
      status:
        rejectRate === null
          ? "unknown"
          : rejectRate < t.rejectRate
            ? "pass"
            : "fail",
      actual: rejectRate,
      threshold: t.rejectRate,
    },
    {
      id: "injections",
      status:
        injectionsThrough > t.injectionsThrough
          ? "fail"
          : injectionScanned
            ? "pass"
            : "unknown",
      actual:
        injectionScanned || injectionsThrough > 0 ? injectionsThrough : null,
      threshold: t.injectionsThrough,
    },
    {
      id: "cost",
      status: noWorse(costUsd.shadow, costUsd.old),
      actual: costUsd.shadow,
      threshold: costUsd.old,
    },
    {
      id: "p95_time",
      status: noWorse(p95Ms.shadow, p95Ms.old),
      actual: p95Ms.shadow,
      threshold: p95Ms.old,
    },
  ]
  return {
    version: INGESTION_COMPARISON_VERSION,
    generatedAt: now.toISOString(),
    runs,
    totals: {
      units,
      claims,
      ops,
      rejects,
      rejectRate,
      injectionsThrough,
      p95Ms,
      costUsd,
      labels: labeled.length
        ? {
            units: addLabels((l) => l.units),
            claims: addLabels((l) => l.claims),
          }
        : null,
    },
    exit: {
      ready:
        !runs.some((run) =>
          run.revisionGaps?.some((gap) => !gap.resolvedByOverride),
        ) && criteria.every((c) => c.status === "pass"),
      criteria,
    },
  }
}

const percent = (value: number | null) =>
  value === null ? "n/a" : `${(value * 100).toFixed(1)}%`
const amount = (value: number | null, unit: string) =>
  value === null ? "n/a" : `${Number(value.toFixed(3))} ${unit}`

/** The report as Markdown, for the Linear document of the T20 issue. */
export function renderComparisonMarkdown(
  report: IngestionComparisonReport,
): string {
  const t = report.totals
  const value = (c: ExitCriterion) =>
    c.id === "cost"
      ? `${amount(c.actual, "USD")} (old ${amount(c.threshold, "USD")})`
      : c.id === "p95_time"
        ? `${amount(c.actual, "ms")} (old ${amount(c.threshold, "ms")})`
        : c.id === "injections"
          ? `${c.actual ?? "n/a"} (max ${c.threshold})`
          : `${percent(c.actual)} (${c.id === "reject_rate" ? "below" : "at least"} ${percent(c.threshold)})`
  const lines = [
    `# Ingestion shadow comparison`,
    "",
    `Generated ${report.generatedAt}. Runs: ${report.runs.length}. Ready to publish: **${report.exit.ready ? "yes" : "no"}**.`,
    "",
    "| Criterion | Status | Value |",
    "| -- | -- | -- |",
    ...report.exit.criteria.map(
      (c) => `| ${c.id} | ${c.status} | ${value(c)} |`,
    ),
    "",
    `Units: ${t.units.matched} of ${t.units.old} old units found, ${t.units.shadow} shadow units. Claims: ${t.claims.matched} of ${t.claims.old} old claims found, ${t.claims.shadow} shadow claims. Ops ${t.ops}, rejects ${t.rejects}.`,
  ]
  if (t.labels)
    lines.push(
      "",
      `Labeled set: units old ${t.labels.units.old} and shadow ${t.labels.units.shadow} of ${t.labels.units.expected}; claims old ${t.labels.claims.old} and shadow ${t.labels.claims.shadow} of ${t.labels.claims.expected}.`,
    )
  for (const run of report.runs) {
    lines.push(
      "",
      `## ${run.sourceUrl} at ${run.sha.slice(0, 12)}`,
      "",
      `Shadow run ${run.shadowRunId} (${run.status}), old run ${run.oldRunId ?? "unknown"}. Time: old ${amount(run.durationMs.old, "ms")}, shadow ${amount(run.durationMs.shadow, "ms")}.`,
    )
    for (const gap of run.revisionGaps ?? [])
      lines.push(
        `Missing stored ${gap.field} for Workspace ${gap.workspaceId}: ${gap.resolvedByOverride ? "manual override used" : "comparison unavailable"}.`,
      )
    for (const w of run.workspaces) {
      lines.push(
        "",
        `### Workspace ${w.workspaceId}`,
        "",
        `Unit recall ${percent(w.units.recall)} (${w.units.matched}/${w.units.old}), claim recall ${percent(w.claims.recall)} (${w.claims.matched}/${w.claims.old}), reject rate ${percent(w.quality.rejectRate)}, partial ${w.quality.partial}${w.quality.refused ? `, refused: ${w.quality.refused}` : ""}.`,
      )
      for (const [title, groups] of [
        ["Unit kind", w.units.byKind],
        ["Claim predicate", w.claims.byPredicate],
      ] as const) {
        lines.push(
          "",
          `| ${title} | Old | Shadow | Matched |`,
          "| -- | -- | -- | -- |",
        )
        for (const [name, counts] of Object.entries(groups).sort(([a], [b]) =>
          a.localeCompare(b),
        ))
          lines.push(
            `| ${name.replace(/\|/g, "\\|")} | ${counts.old} | ${counts.shadow} | ${counts.matched} |`,
          )
      }
      const list = (title: string, items: string[]) => {
        if (items.length)
          lines.push("", `${title}:`, ...items.map((i) => `- ${i}`))
      }
      list(
        "Missing units",
        w.units.missing.map((u) => `${u.kind} ${u.name} (\`${u.path}\`)`),
      )
      list(
        "Extra units",
        w.units.extra.map((u) => `${u.kind} ${u.name} (\`${u.path}\`)`),
      )
      list(
        "Kind changes",
        w.units.kindChanges.map(
          (k) => `${k.name}: ${k.oldKind} to ${k.shadowKind}`,
        ),
      )
      list(
        "Missing claims",
        w.claims.missing.map((c) => `${c.subject} ${c.predicate} ${c.object}`),
      )
      list(
        "Extra claims",
        w.claims.extra.map((c) => `${c.subject} ${c.predicate} ${c.object}`),
      )
      list(
        "Injections through",
        w.quality.injectionsThrough.map(
          (i) => `${i.payloadId} in \`${i.path}\``,
        ),
      )
    }
  }
  return `${lines.join("\n")}\n`
}
