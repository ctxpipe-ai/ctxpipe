/**
 * Seed a realistic knowledge graph for visualisation / demo purposes.
 *
 * Writes into Postgres (`objects`, `claims`, `claim_evidence`) under a stable
 * `deduplicationKey` prefix ("seed:"), then projects to FalkorDB via the same
 * `projectClaimsFromState` path production uses. Rerunnable: re-running without
 * `--clear` is idempotent per dedup key (claims may accrue extra evidence).
 *
 * Usage (repo root):
 *   pnpm --filter @ctxpipe/backend run seed-kg -- --org-slug <slug> [--clear] [--scale 1000]
 *
 * Env: apps/backend/.env.local — DATABASE_URL, GRAPH_DB_URI, AUTH_SECRET.
 */

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { and, eq, like, sql } from "drizzle-orm"
import { withOrgIdContext } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import {
  closeDb,
  getOrgDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { claimEvidence } from "../db/schema/claim_evidence.js"
import { claims } from "../db/schema/claims.js"
import { objects } from "../db/schema/objects.js"
import { generateObjectId } from "../lib/id.js"
import {
  createLogger,
  initEvlog,
  log,
  withLogger,
} from "../observability/logger.js"
import {
  CORE_ALLOWED_CONNECTIONS,
  EXTENSION_ALLOWED_CONNECTIONS,
} from "../retrieval/schema/allowedConnections.js"
import type { ClaimForProjection } from "../retrieval/schema/claimForProjection.js"
import {
  deleteObjectFromGraph,
  projectClaimsFromState,
  retractClaimFromGraph,
} from "../retrieval/services/graphProjection.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })
initEvlog()

const SEED_PREFIX = "seed"
const ALLOWED = [...CORE_ALLOWED_CONNECTIONS, ...EXTENSION_ALLOWED_CONNECTIONS]
const OBJECT_INSERT_BATCH = 500
const CLAIM_INSERT_BATCH = 500
/** Target ratio of claims to objects. Kept modest at scale to bound projection time. */
const CLAIM_TO_OBJECT_RATIO = 1.5
/** Falkor projection in chunks so we see progress (one sequential Cypher call per claim inside). */
const PROJECTION_CHUNK = 250

function progress(msg: string): void {
  process.stderr.write(`[seed-kg] ${msg}\n`)
}

// Five fictional product themes so the graph has visible clusters in the viz.
const THEMES = ["fintech", "commerce", "social", "dataplatform", "devtools"]
const THEME_SERVICES: Record<string, string[]> = {
  fintech: [
    "payments",
    "accounts",
    "ledger",
    "fraud",
    "kyc",
    "disputes",
    "settlement",
    "card-issuer",
    "payouts",
    "statements",
  ],
  commerce: [
    "checkout",
    "cart",
    "inventory",
    "catalog",
    "recommendations",
    "search",
    "pricing",
    "shipping",
    "returns",
    "reviews",
  ],
  social: [
    "feed",
    "follow",
    "messages",
    "notifications",
    "timeline",
    "stories",
    "reactions",
    "moderation",
    "presence",
    "profile",
  ],
  dataplatform: [
    "ingestion",
    "etl",
    "warehouse",
    "lake",
    "metrics",
    "scheduler",
    "catalog-svc",
    "lineage",
    "ml-inference",
    "ml-training",
  ],
  devtools: [
    "auth",
    "billing",
    "monitoring",
    "alerting",
    "logs",
    "traces",
    "secrets",
    "deploy",
    "config",
    "featureflags",
  ],
}

const TIERS = ["tier-0", "tier-1", "tier-2", "tier-3"] as const
const LANGUAGES = [
  "typescript",
  "go",
  "python",
  "rust",
  "java",
  "kotlin",
] as const
const DB_ENGINES = [
  "postgres",
  "mysql",
  "redis",
  "cassandra",
  "clickhouse",
  "mongodb",
  "dynamodb",
] as const
const STREAM_PLATFORMS = ["kafka", "kinesis", "pubsub", "nats"] as const
const INFRA_KINDS = [
  "kubernetes",
  "serverless",
  "vm",
  "container-service",
] as const
const INFRA_PLATFORMS = ["aws", "gcp", "azure", "fly"] as const
const PATTERN_CATEGORIES = [
  "circuit-breaker",
  "retry-with-backoff",
  "saga",
  "cqrs",
  "outbox",
  "idempotency-key",
  "rate-limit",
  "bulkhead",
]
const LIBRARY_PACKAGES = [
  "zod",
  "drizzle-orm",
  "hono",
  "axios",
  "prisma",
  "react",
  "lodash",
  "opentelemetry",
  "grpc",
  "graphql",
  "tanstack-query",
  "nanoid",
]

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)] as T
}

/**
 * Deterministic RNG (mulberry32). Same `--org-slug` + `--scale` produce the
 * same shape, so re-runs don't invent a new graph every time.
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function stringSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

type SeedObject = {
  id: string
  kind: string
  name: string
  deduplicationKey: string
  payload: Record<string, unknown>
}

const KIND_LIST = [
  "Repository",
  "Service",
  "App",
  "Library",
  "Database",
  "API",
  "Operation",
  "Stream",
  "Infrastructure",
  "Pattern",
  "InstructionUnit",
  "Concept",
  "Topic",
  "Capability",
  "Decision",
  "Incident",
  "Skill",
] as const
type Kind = (typeof KIND_LIST)[number]
type KindCounts = Record<Kind, number>

/**
 * Target distribution. Kinds with a `cap` saturate (real-world ceilings — you
 * don't have 8k Repositories or 300 Infrastructure clusters). Leftover budget
 * from saturated kinds spills into uncapped "naturally-many" kinds.
 */
const DISTRIBUTION: Array<{ kind: Kind; ratio: number; cap?: number }> = [
  { kind: "Repository", ratio: 0.01, cap: 40 },
  { kind: "Service", ratio: 0.12 },
  { kind: "App", ratio: 0.04, cap: 80 },
  { kind: "Library", ratio: 0.14 },
  { kind: "Database", ratio: 0.04, cap: 80 },
  { kind: "API", ratio: 0.07 },
  { kind: "Operation", ratio: 0.18 },
  { kind: "Stream", ratio: 0.02, cap: 60 },
  { kind: "Infrastructure", ratio: 0.02, cap: 50 },
  { kind: "Pattern", ratio: 0.03, cap: 80 },
  { kind: "InstructionUnit", ratio: 0.12 },
  { kind: "Concept", ratio: 0.07, cap: 300 },
  { kind: "Topic", ratio: 0.05, cap: 120 },
  { kind: "Capability", ratio: 0.03, cap: 80 },
  { kind: "Decision", ratio: 0.03, cap: 200 },
  { kind: "Incident", ratio: 0.03, cap: 300 },
  { kind: "Skill", ratio: 0.03, cap: 150 },
]

function defaultDistribution(scale: number): KindCounts {
  const out = {} as KindCounts
  const raw: Record<Kind, number> = {} as Record<Kind, number>
  let uncappedBudget = 0
  let savedFromCaps = 0

  for (const e of DISTRIBUTION) {
    const ideal = Math.max(1, Math.round(scale * e.ratio))
    if (e.cap !== undefined && ideal > e.cap) {
      raw[e.kind] = e.cap
      savedFromCaps += ideal - e.cap
    } else {
      raw[e.kind] = ideal
      if (e.cap === undefined) uncappedBudget += ideal
    }
  }

  // Redistribute the saved budget proportionally into uncapped kinds so total ≈ scale.
  if (savedFromCaps > 0 && uncappedBudget > 0) {
    for (const e of DISTRIBUTION) {
      if (e.cap !== undefined) continue
      const share = raw[e.kind] / uncappedBudget
      raw[e.kind] = Math.round(raw[e.kind] + savedFromCaps * share)
    }
  }

  for (const e of DISTRIBUTION) out[e.kind] = raw[e.kind]
  return out
}

function generateObjects(
  scale: number,
  rng: () => number,
): {
  byKind: Map<string, SeedObject[]>
  all: SeedObject[]
} {
  const dist = defaultDistribution(scale)
  const byKind = new Map<string, SeedObject[]>()
  const all: SeedObject[] = []
  let seq = 0

  const mk = (
    kind: string,
    key: string,
    name: string,
    payload: Record<string, unknown>,
  ): SeedObject => {
    const dedup = `${SEED_PREFIX}:${kind.toLowerCase()}:${key}`
    const id = generateObjectId("obj")
    seq++
    return {
      id,
      kind,
      name,
      deduplicationKey: dedup,
      payload: { ...payload, name },
    }
  }

  const push = (o: SeedObject) => {
    if (!byKind.has(o.kind)) byKind.set(o.kind, [])
    byKind.get(o.kind)?.push(o)
    all.push(o)
  }

  // Repositories — one per theme plus shared infra repos.
  const repoNames = [
    ...THEMES.map((t) => `${t}-monorepo`),
    "shared-platform",
    "infra",
    "docs",
    "design-system",
  ].slice(0, dist.Repository)
  for (const name of repoNames) {
    push(
      mk("Repository", name, name, {
        summary: `Source-of-truth repo for ${name}`,
      }),
    )
  }

  // Services — themed, clustered via owner_team = theme.
  const serviceCount = dist.Service
  for (let i = 0; i < serviceCount; i++) {
    const theme = THEMES[i % THEMES.length] as string
    const roles = THEME_SERVICES[theme] ?? ["svc"]
    const role = roles[Math.floor(rng() * roles.length)] ?? "svc"
    const suffix = Math.floor(i / THEMES.length)
    const name =
      suffix === 0 ? `${theme}-${role}` : `${theme}-${role}-${suffix}`
    push(
      mk("Service", name, name, {
        summary: `${role} service in the ${theme} domain`,
        owner_team: theme,
        tier: pick(TIERS, rng),
        language: pick(LANGUAGES, rng),
      }),
    )
  }

  // Apps — web / mobile surfaces per theme.
  for (let i = 0; i < dist.App; i++) {
    const theme = THEMES[i % THEMES.length] as string
    const platform = pick(["web", "ios", "android", "desktop"] as const, rng)
    const name = `${theme}-${platform}`
    push(
      mk("App", `${theme}-${platform}-${i}`, name, {
        summary: `${theme} ${platform} client`,
        platform,
        package: `com.example.${theme}.${platform}`,
      }),
    )
  }

  // Libraries — shared packages + generic OSS.
  for (let i = 0; i < dist.Library; i++) {
    const isPlatform = i < Math.floor(dist.Library / 2)
    const base = isPlatform
      ? `platform-${pick(["logging", "metrics", "auth", "config", "http", "cache", "tracing", "grpc"] as const, rng)}`
      : pick(LIBRARY_PACKAGES, rng)
    const name = isPlatform ? base : `${base}-client`
    push(
      mk("Library", `lib-${i}`, name, {
        summary: `Reusable library: ${name}`,
        language: pick(LANGUAGES, rng),
        package: name,
      }),
    )
  }

  // Databases — one or two per theme.
  for (let i = 0; i < dist.Database; i++) {
    const theme = THEMES[i % THEMES.length] as string
    const role = pick(
      ["primary", "analytics", "cache", "search", "queue"] as const,
      rng,
    )
    const name = `${theme}-${role}-db-${Math.floor(i / THEMES.length)}`
    push(
      mk("Database", name, name, {
        summary: `${theme} ${role} datastore`,
        engine: pick(DB_ENGINES, rng),
        cluster: `${theme}-${role}`,
      }),
    )
  }

  // APIs — themed public/internal surfaces.
  for (let i = 0; i < dist.API; i++) {
    const theme = THEMES[i % THEMES.length] as string
    const scope = pick(["public", "internal", "admin"] as const, rng)
    const name = `${theme}-${scope}-api-${Math.floor(i / THEMES.length)}`
    push(
      mk("API", name, name, {
        summary: `${theme} ${scope} API`,
        protocol: pick(["rest", "grpc", "graphql"] as const, rng),
        version: pick(["v1", "v2", "v3"] as const, rng),
      }),
    )
  }

  // Operations — 2-3 per API.
  const apiList = byKind.get("API") ?? []
  const opCount = dist.Operation
  for (let i = 0; i < opCount; i++) {
    const api = apiList[i % Math.max(apiList.length, 1)]
    if (!api) break
    const verb = pick(
      ["get", "list", "create", "update", "delete", "search"] as const,
      rng,
    )
    const noun = pick(
      ["item", "record", "resource", "entity", "token", "event"] as const,
      rng,
    )
    const name = `${api.name}.${verb}${noun.charAt(0).toUpperCase()}${noun.slice(1)}`
    push(
      mk("Operation", `op-${i}`, name, {
        summary: `${verb} ${noun} on ${api.name}`,
      }),
    )
  }

  // Streams — message buses per theme.
  for (let i = 0; i < dist.Stream; i++) {
    const theme = THEMES[i % THEMES.length] as string
    const role = pick(["events", "commands", "audit", "metrics"] as const, rng)
    const name = `${theme}.${role}`
    push(
      mk("Stream", `stream-${i}`, name, {
        summary: `${theme} ${role} stream`,
        platform: pick(STREAM_PLATFORMS, rng),
        schema_name: `${theme}_${role}_v1`,
      }),
    )
  }

  // Infrastructure — compute platforms.
  for (let i = 0; i < dist.Infrastructure; i++) {
    const kind = pick(INFRA_KINDS, rng)
    const platform = pick(INFRA_PLATFORMS, rng)
    const name = `${platform}-${kind}-${i}`
    push(
      mk("Infrastructure", `infra-${i}`, name, {
        summary: `${platform} ${kind} cluster`,
        infra_kind: kind,
        platform,
      }),
    )
  }

  // Patterns — architectural choices.
  for (let i = 0; i < dist.Pattern; i++) {
    const cat = PATTERN_CATEGORIES[i % PATTERN_CATEGORIES.length] as string
    const name = `${cat}-${Math.floor(i / PATTERN_CATEGORIES.length)}`
    push(
      mk("Pattern", `pat-${i}`, name, {
        summary: `Implementation of the ${cat} pattern`,
        category: cat,
      }),
    )
  }

  // Instruction units — code-level tactical guidance.
  for (let i = 0; i < dist.InstructionUnit; i++) {
    const intent = pick(
      [
        "use-X-for-Y",
        "prefer-A-over-B",
        "avoid-C",
        "invariant",
        "tradeoff",
      ] as const,
      rng,
    )
    const modality = pick(
      ["rule", "guideline", "convention", "decision"] as const,
      rng,
    )
    const theme = THEMES[i % THEMES.length] as string
    const name = `${theme}: ${intent} #${i}`
    push(
      mk("InstructionUnit", `inu-${i}`, name, {
        summary: `${modality} — ${intent} for ${theme}`,
        intent,
        modality,
        path: `${theme}/src/guidelines/${i}.md`,
      }),
    )
  }

  // Concepts — conceptual anchors across domains.
  const conceptNouns = [
    "idempotency",
    "eventual-consistency",
    "write-ahead-log",
    "backpressure",
    "multi-tenancy",
    "row-level-security",
    "sharding",
    "cache-invalidation",
    "exactly-once",
    "saga-compensation",
    "feature-flag",
    "canary-release",
  ]
  for (let i = 0; i < dist.Concept; i++) {
    const name =
      conceptNouns[i % conceptNouns.length] +
      (i >= conceptNouns.length
        ? `-${Math.floor(i / conceptNouns.length)}`
        : "")
    push(mk("Concept", `concept-${i}`, name, { summary: `Concept: ${name}` }))
  }

  // Topics — broader groupings.
  const topicNouns = [
    "reliability",
    "security",
    "performance",
    "observability",
    "compliance",
    "cost",
    "dx",
    "onboarding",
  ]
  for (let i = 0; i < dist.Topic; i++) {
    const name =
      topicNouns[i % topicNouns.length] +
      (i >= topicNouns.length ? `-${Math.floor(i / topicNouns.length)}` : "")
    push(mk("Topic", `topic-${i}`, name, { summary: `Topic: ${name}` }))
  }

  // Capabilities — business-facing.
  const capNouns = [
    "checkout",
    "onboarding",
    "reporting",
    "dashboard",
    "export",
    "self-serve-billing",
  ]
  for (let i = 0; i < dist.Capability; i++) {
    const name =
      capNouns[i % capNouns.length] +
      (i >= capNouns.length ? `-${Math.floor(i / capNouns.length)}` : "")
    push(mk("Capability", `cap-${i}`, name, { summary: `Capability: ${name}` }))
  }

  // Decisions — ADR-style.
  for (let i = 0; i < dist.Decision; i++) {
    const name = `ADR-${String(i + 100).padStart(3, "0")}`
    push(
      mk("Decision", `dec-${i}`, name, {
        summary: `Architecture decision: ${name}`,
      }),
    )
  }

  // Incidents — recent severity mix.
  for (let i = 0; i < dist.Incident; i++) {
    const sev = pick(["sev-1", "sev-2", "sev-3"] as const, rng)
    const name = `INC-${String(i + 1).padStart(4, "0")} (${sev})`
    push(
      mk("Incident", `inc-${i}`, name, {
        summary: `${sev} incident ${i + 1}`,
      }),
    )
  }

  // Skills — generalised competencies linked to instruction units.
  const skillNouns = [
    "graph-retrieval",
    "multi-tenant-auth",
    "event-sourcing",
    "data-migration",
    "release-engineering",
    "cost-optimisation",
  ]
  for (let i = 0; i < dist.Skill; i++) {
    const name =
      skillNouns[i % skillNouns.length] +
      (i >= skillNouns.length ? `-${Math.floor(i / skillNouns.length)}` : "")
    push(
      mk("Skill", `skill-${i}`, name, {
        summary: `Skill: ${name}`,
        intent_summary: `Be effective at ${name}`,
      }),
    )
  }

  return { byKind, all }
}

type PendingClaim = {
  id: string
  subjectId: string
  subjectKind: string
  objectId: string
  objectKind: string
  predicate: string
  confidence: number
  lastObservedAt: Date
}

function generateClaims(
  byKind: Map<string, SeedObject[]>,
  objectTotal: number,
  rng: () => number,
): PendingClaim[] {
  const list: PendingClaim[] = []
  const now = Date.now()
  const daysAgo = (days: number) => new Date(now - days * 86400_000)

  // Per-predicate density: how many object-side targets each subject picks on
  // average. These values were tuned for ~2.5 claims per object at scale=1000.
  const baseDensity: Record<string, number> = {
    IMPLEMENTED_IN: 1,
    DEPENDS_ON: 2,
    EXPOSES_API: 0.6,
    CONSUMES_API: 1.4,
    HAS_OPERATION: 1,
    PRODUCES_TO: 0.5,
    CONSUMES_FROM: 0.5,
    READS_FROM: 0.8,
    WRITES_TO: 0.8,
    USES_LIBRARY: 2.5,
    IMPLEMENTS_PATTERN: 0.7,
    RUNS_ON: 0.6,
    HAS_INSTRUCTION: 0.8,
    RELATES_TO: 1.1,
    ABOUT: 0.9,
    ASSOCIATED_WITH: 1.2,
    INFLUENCES: 1.0,
    MENTIONS: 1.2,
    MEMBER_OF_PRIMARY: 1,
  }

  // Estimate claim total under raw density, then scale density down so actual
  // total lands near objectTotal * CLAIM_TO_OBJECT_RATIO. Prevents 200k objects
  // producing multi-million claims and multi-hour projection runs.
  let estimated = 0
  for (const conn of ALLOWED) {
    const subs = byKind.get(conn.subjectKind)?.length ?? 0
    const d = baseDensity[conn.predicate] ?? 1
    estimated += subs * d
  }
  const targetClaims = Math.round(objectTotal * CLAIM_TO_OBJECT_RATIO)
  const dampener = estimated > targetClaims ? targetClaims / estimated : 1

  for (const conn of ALLOWED) {
    const subs = byKind.get(conn.subjectKind) ?? []
    const objs = byKind.get(conn.objectKind) ?? []
    if (subs.length === 0 || objs.length === 0) continue

    const targetRate = (baseDensity[conn.predicate] ?? 1) * dampener
    // Keep self-referential predicates (e.g. Concept → Concept) sparse to
    // avoid visual hairballs.
    const selfRef = conn.subjectKind === conn.objectKind
    const rate = selfRef ? Math.min(targetRate, 0.6) : targetRate

    for (const s of subs) {
      // Poisson-like: use rate as expected count; jitter adds ±rate variance but
      // stays non-negative. For rate<1 (common after dampening), rounds to 0 or 1.
      const n = Math.max(
        0,
        Math.round(rate + (rng() - 0.5) * Math.max(rate, 0.5)),
      )
      const picked = new Set<string>()
      for (let i = 0; i < n; i++) {
        const o = objs[Math.floor(rng() * objs.length)] as SeedObject
        if (o.id === s.id) continue
        const key = `${s.id}|${conn.predicate}|${o.id}`
        if (picked.has(key)) continue
        picked.add(key)
        list.push({
          id: generateObjectId("claim"),
          subjectId: s.id,
          subjectKind: conn.subjectKind,
          objectId: o.id,
          objectKind: conn.objectKind,
          predicate: conn.predicate,
          confidence: 0.7 + rng() * 0.25,
          lastObservedAt: daysAgo(Math.floor(rng() * 30)),
        })
      }
    }
  }

  return list
}

async function chunkInsert<T>(
  rows: T[],
  batchSize: number,
  insertFn: (batch: T[]) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    await insertFn(rows.slice(i, i + batchSize))
  }
}

async function clearSeedData(orgId: string): Promise<void> {
  const db = getOrgDb()

  const seedClaimsRows = await db
    .select({
      id: claims.id,
      subjectId: claims.subjectId,
      objectId: claims.objectId,
    })
    .from(claims)
    .innerJoin(objects, eq(objects.id, claims.subjectId))
    .where(
      and(
        eq(claims.orgId, orgId),
        like(objects.deduplicationKey, `${SEED_PREFIX}:%`),
      ),
    )

  for (const c of seedClaimsRows) {
    try {
      await retractClaimFromGraph(c.id)
    } catch {
      // best-effort — graph may already be out of sync
    }
  }

  if (seedClaimsRows.length > 0) {
    await db.execute(
      sql`DELETE FROM claim_evidence WHERE claim_id IN (
            SELECT c.id FROM claims c
            JOIN objects o ON o.id = c.subject_id
            WHERE c.org_id = ${orgId}
              AND o.deduplication_key LIKE ${`${SEED_PREFIX}:%`}
          )`,
    )
    await db.execute(
      sql`DELETE FROM claims
          WHERE id IN (
            SELECT c.id FROM claims c
            JOIN objects o ON o.id = c.subject_id
            WHERE c.org_id = ${orgId}
              AND o.deduplication_key LIKE ${`${SEED_PREFIX}:%`}
          )`,
    )
  }

  const seedObjectRows = await db
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        like(objects.deduplicationKey, `${SEED_PREFIX}:%`),
      ),
    )

  for (const o of seedObjectRows) {
    try {
      await deleteObjectFromGraph(o.id)
    } catch {
      // best-effort
    }
  }

  if (seedObjectRows.length > 0) {
    await db.execute(
      sql`DELETE FROM objects
          WHERE org_id = ${orgId}
            AND deduplication_key LIKE ${`${SEED_PREFIX}:%`}`,
    )
  }

  log.info({
    step: "seedKnowledgeGraph.clear",
    message: "Cleared seed data",
    claims: seedClaimsRows.length,
    objects: seedObjectRows.length,
  })
}

function parseArgs(argv: string[]): {
  orgSlug: string
  scale: number
  clear: boolean
} {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    const next = i >= 0 ? argv[i + 1] : undefined
    return next !== undefined && !next.startsWith("-") ? next : undefined
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    log.info({
      step: "seedKnowledgeGraph.cli",
      message: `Usage:
  pnpm --filter @ctxpipe/backend run seed-kg -- --org-slug <slug> [--scale 1000] [--clear]

  --scale  Approximate total object count (default 1000).
  --clear  Drop prior seed rows (deduplication_key LIKE 'seed:%') before inserting.`,
    })
    process.exit(0)
  }
  const orgSlug = get("--org-slug")
  const scaleStr = get("--scale")
  const scale = scaleStr ? Number(scaleStr) : 1000
  const clear = argv.includes("--clear")
  if (!orgSlug) {
    log.error({
      step: "seedKnowledgeGraph.cli",
      message: "Missing required --org-slug",
    })
    process.exit(1)
  }
  if (!Number.isFinite(scale) || scale < 20 || scale > 500_000) {
    log.error({
      step: "seedKnowledgeGraph.cli",
      message: `--scale must be between 20 and 500000 (got ${scaleStr})`,
    })
    process.exit(1)
  }
  return { orgSlug, scale, clear }
}

async function main(): Promise<void> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  initDb(env.DATABASE_URL)
  const { orgSlug, scale, clear } = parseArgs(process.argv.slice(2))

  const systemDb = getSystemDb()
  const orgRows = await systemDb
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.slug, orgSlug))
    .limit(1)
  const org = orgRows[0]
  if (!org) {
    log.error({
      step: "seedKnowledgeGraph.cli",
      message: `No organization found for slug=${orgSlug}`,
    })
    process.exit(1)
  }

  try {
    await withOrgIdContext({ id: org.id, slug: org.slug }, () =>
      withOrgDbContext(org.id, async () => {
        const db = getOrgDb()

        if (clear) {
          progress("Clearing prior seed data")
          await clearSeedData(org.id)
        }

        progress(`Generating objects (scale=${scale})`)
        const rng = makeRng(stringSeed(`${orgSlug}:${scale}`))
        const { byKind, all: objectsToInsert } = generateObjects(scale, rng)
        const dist = Object.fromEntries(
          [...byKind.entries()].map(([k, v]) => [k, v.length]),
        )
        progress(
          `Objects to insert: ${objectsToInsert.length} across ${byKind.size} kinds`,
        )
        progress(`Distribution: ${JSON.stringify(dist)}`)
        log.info({
          step: "seedKnowledgeGraph.objects",
          message: `Inserting ${objectsToInsert.length} objects`,
          distribution: dist,
        })

        let insertedObjects = 0
        await chunkInsert(
          objectsToInsert,
          OBJECT_INSERT_BATCH,
          async (batch) => {
            await db
              .insert(objects)
              .values(
                batch.map((o) => ({
                  id: o.id,
                  orgId: org.id,
                  kind: o.kind,
                  deduplicationKey: o.deduplicationKey,
                  payload: o.payload,
                  searchContent: [o.kind, o.name, o.payload.summary ?? ""]
                    .filter(Boolean)
                    .join(" "),
                })),
              )
              .onConflictDoNothing()
            insertedObjects += batch.length
            if (insertedObjects % (OBJECT_INSERT_BATCH * 10) === 0) {
              progress(
                `Inserted ${insertedObjects}/${objectsToInsert.length} objects`,
              )
            }
          },
        )
        progress(`Inserted all ${objectsToInsert.length} objects`)

        progress("Generating claims")
        const pendingClaims = generateClaims(
          byKind,
          objectsToInsert.length,
          rng,
        )
        progress(
          `Claims to insert: ${pendingClaims.length} (target ratio ${CLAIM_TO_OBJECT_RATIO}x)`,
        )
        log.info({
          step: "seedKnowledgeGraph.claims",
          message: `Inserting ${pendingClaims.length} claims`,
        })

        let insertedClaims = 0
        await chunkInsert(pendingClaims, CLAIM_INSERT_BATCH, async (batch) => {
          await db.insert(claims).values(
            batch.map((c) => ({
              id: c.id,
              orgId: org.id,
              subjectId: c.subjectId,
              predicate: c.predicate,
              objectId: c.objectId,
              status: "active",
              firstObservedAt: c.lastObservedAt,
              lastObservedAt: c.lastObservedAt,
              aggregatedConfidence: c.confidence,
            })),
          )
          await db.insert(claimEvidence).values(
            batch.map((c) => ({
              id: generateObjectId("ev"),
              claimId: c.id,
              sourceType: "manual",
              sourceId: `${SEED_PREFIX}:${c.predicate}:${c.subjectId}:${c.objectId}`,
              logicalSourceKey: `${SEED_PREFIX}:${c.predicate}:${c.subjectId}:${c.objectId}`,
              extractionMethod: "seed",
              confidence: c.confidence,
              observedAt: c.lastObservedAt,
              provenance: { source: "seedKnowledgeGraph" },
            })),
          )
          insertedClaims += batch.length
          if (insertedClaims % (CLAIM_INSERT_BATCH * 10) === 0) {
            progress(
              `Inserted ${insertedClaims}/${pendingClaims.length} claims`,
            )
          }
        })
        progress(`Inserted all ${pendingClaims.length} claims`)

        progress(
          `Projecting to FalkorDB in chunks of ${PROJECTION_CHUNK} (sequential — each claim is one Cypher MERGE)`,
        )
        let projectedTotal = 0
        let projectionErrors = 0
        for (let i = 0; i < pendingClaims.length; i += PROJECTION_CHUNK) {
          const chunk = pendingClaims.slice(i, i + PROJECTION_CHUNK)
          const chunkInput: ClaimForProjection[] = chunk.map((c) => ({
            id: c.id,
            subjectId: c.subjectId,
            objectId: c.objectId,
            subjectKind: c.subjectKind,
            objectKind: c.objectKind,
            predicate: c.predicate,
            status: "active",
            aggregatedConfidence: c.confidence,
            sourceCount: 1,
            lastObservedAt: c.lastObservedAt.toISOString(),
            validFrom: null,
            validTo: null,
          }))
          const t0 = Date.now()
          const result = await withLogger(
            createLogger({ step: "seedKnowledgeGraph.project", orgId: org.id }),
            () => projectClaimsFromState(chunkInput),
          )
          projectedTotal += result.projected
          projectionErrors += result.errors.length
          const elapsed = Date.now() - t0
          progress(
            `Projected ${projectedTotal}/${pendingClaims.length} (chunk took ${elapsed}ms)`,
          )
        }

        const summary = {
          ok: true as const,
          orgSlug,
          orgId: org.id,
          scale,
          objects: objectsToInsert.length,
          claims: pendingClaims.length,
          projected: projectedTotal,
          projectionErrors,
        }
        progress(`Seed complete: ${JSON.stringify(summary)}`)
        log.info({
          step: "seedKnowledgeGraph.complete",
          message: "Seed complete",
          ...summary,
        })
        process.stdout.write(`${JSON.stringify(summary)}\n`)
      }),
    )
  } finally {
    await closeDb()
  }
}

void main()
