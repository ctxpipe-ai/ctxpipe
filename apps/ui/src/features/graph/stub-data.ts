export type EntityType =
  | "Repository"
  | "File"
  | "Function"
  | "Class"
  | "Concept"

export type RelationshipType = "related_to" | "mentions"

export type GraphNode = {
  id: string
  name: string
  type: EntityType
  description?: string
  /** Denormalised from the BELONGS_TO relationship for query convenience */
  repository?: string
}

/**
 * GraphNode extended with UI-only display fields required by Cosmograph.
 * These are derived from `type` client-side and are never stored in FalkorDB.
 */
export type GraphNodeForRender = GraphNode & {
  color: string
  size: number
}

export type GraphLink = {
  source: string
  target: string
  type: RelationshipType
}

export const ENTITY_COLORS: Record<EntityType, string> = {
  Repository: "#f59e0b",
  File: "#2dd4bf",
  Function: "#60a5fa",
  Class: "#a78bfa",
  Concept: "#fb7185",
}

// ─── Enterprise-scale generator ──────────────────────────────────────────────
// Produces ~4 500 nodes and ~15 000 edges to stress-test GPU rendering.

const DOMAINS = [
  "auth", "user", "payment", "notification", "search", "analytics",
  "reporting", "billing", "subscription", "inventory", "order", "product",
  "catalog", "shipping", "logistics", "warehouse", "supplier", "procurement",
  "hr", "payroll", "onboarding", "identity", "access", "audit", "compliance",
  "fraud", "risk", "kyc", "aml", "data", "etl", "pipeline", "stream",
  "batch", "ml", "inference", "training", "feature", "recommendation",
  "personalisation", "content", "media", "upload", "cdn", "storage",
  "cache", "queue", "event", "webhook", "email", "sms", "push",
  "chat", "video", "document", "export", "import", "integration",
  "gateway", "proxy", "router", "load-balancer", "service-mesh",
  "config", "secrets", "vault", "telemetry", "metrics", "tracing",
  "alerting", "incident", "deploy", "rollout", "canary", "infra",
  "terraform", "k8s", "ci", "sdk", "cli", "admin", "dashboard",
  "portal", "mobile-api", "graphql", "grpc", "websocket", "realtime",
  "scheduler", "cron", "workflow", "approval", "pricing", "discount",
  "tax", "ledger", "reconciliation", "refund", "chargeback",
]

const REPO_SUFFIXES = ["service", "api", "worker", "lib", "sdk", "core", "client"]

const FILE_PREFIXES = [
  "router", "controller", "handler", "service", "repository", "model",
  "schema", "middleware", "config", "utils", "helpers", "validators",
  "serializers", "events", "jobs", "tasks", "hooks", "types", "errors",
  "constants", "migrations", "seeds", "tests",
]

const CLASS_PREFIXES = [
  "Manager", "Service", "Repository", "Controller", "Handler",
  "Processor", "Validator", "Serializer", "Builder", "Factory",
  "Observer", "Adapter", "Gateway", "Client", "Provider",
]

const FUNCTION_PREFIXES = [
  "get", "create", "update", "delete", "list", "find", "validate",
  "process", "handle", "send", "fetch", "load", "parse", "format",
  "transform", "calculate", "generate", "check", "verify", "resolve",
  "build", "init", "teardown", "retry", "schedule",
]

const CONCEPTS = [
  "CQRS", "Event Sourcing", "Domain Events", "Saga Pattern", "Outbox Pattern",
  "Circuit Breaker", "Rate Limiting", "Idempotency", "Distributed Tracing",
  "Service Discovery", "API Versioning", "Pagination", "Cursor Pagination",
  "Optimistic Locking", "Pessimistic Locking", "Soft Delete", "Audit Log",
  "Multi-tenancy", "Row-level Security", "Feature Flags", "A/B Testing",
  "Canary Release", "Blue-Green Deploy", "Zero-downtime Migration",
  "Data Sharding", "Read Replica", "Write-ahead Log", "Change Data Capture",
  "Message Queue", "Dead Letter Queue", "Backpressure", "Exactly-once Delivery",
  "JWT", "OAuth 2.0", "OIDC", "RBAC", "ABAC", "Zero Trust",
  "Embeddings", "Vector Search", "RAG", "LLM Routing", "Prompt Caching",
  "OpenTelemetry", "Structured Logging", "Health Check", "Graceful Shutdown",
  "Dependency Injection", "Hexagonal Architecture", "Clean Architecture",
  "Repository Pattern", "Unit of Work", "Specification Pattern",
]

/** Simple deterministic pseudo-random (seeded) so the graph is stable across renders */
function seededRand(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff
    return (s >>> 0) / 0xffffffff
  }
}

function pick<T>(arr: T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)]
}

function pickN<T>(arr: T[], n: number, rand: () => number): T[] {
  const copy = [...arr]
  const out: T[] = []
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(rand() * copy.length)
    out.push(copy.splice(idx, 1)[0])
  }
  return out
}

function makeNode(
  id: string,
  name: string,
  type: EntityType,
  description?: string,
  repository?: string,
): GraphNodeForRender {
  return {
    id,
    name,
    type,
    description,
    repository,
    color: ENTITY_COLORS[type],
    size: type === "Repository" ? 16 : type === "Concept" ? 11 : 6,
  }
}

function generate(): { nodes: GraphNodeForRender[]; links: GraphLink[] } {
  const rand = seededRand(0xdeadbeef)
  const nodes: GraphNodeForRender[] = []
  const links: GraphLink[] = []

  // ── Concepts (shared across the org) ────────────────────────────────────
  const conceptNodes: GraphNodeForRender[] = pickN(CONCEPTS, 55, rand).map((name, i) =>
    makeNode(`co${i}`, name, "Concept", `Cross-cutting concern: ${name}`),
  )
  nodes.push(...conceptNodes)

  // Concepts reference each other (sparse)
  for (let i = 0; i < conceptNodes.length; i++) {
    if (rand() < 0.25) {
      const j = Math.floor(rand() * conceptNodes.length)
      if (j !== i) {
        links.push({ source: conceptNodes[i].id, target: conceptNodes[j].id, type: "related_to" })
      }
    }
  }

  // ── Repositories ──────────────────────────────────────────────────────
  const repoCount = 100
  const repoNodes: GraphNodeForRender[] = DOMAINS.slice(0, repoCount).map((domain, i) => {
    const suffix = pick(REPO_SUFFIXES, rand)
    return makeNode(
      `r${i}`,
      `${domain}-${suffix}`,
      "Repository",
      `Handles ${domain} domain — owns schema, API surface and business logic`,
    )
  })
  nodes.push(...repoNodes)

  // Track all functions per repo for cross-repo edges later
  const funcsByRepo: Record<string, GraphNodeForRender[]> = {}
  const classesByRepo: Record<string, GraphNodeForRender[]> = {}
  let fileIdx = 0
  let classIdx = 0
  let funcIdx = 0

  // ── Per-repo entities ─────────────────────────────────────────────────
  for (const repo of repoNodes) {
    const fileCount = 14 + Math.floor(rand() * 10)      // 14-23 files
    const classCount = 6 + Math.floor(rand() * 8)       // 6-13 classes
    const funcCount = 14 + Math.floor(rand() * 10)      // 14-23 functions
    const conceptCount = 2 + Math.floor(rand() * 4)     // 2-5 concepts per repo

    // Files
    const repoFiles: GraphNodeForRender[] = []
    for (let f = 0; f < fileCount; f++) {
      const prefix = pick(FILE_PREFIXES, rand)
      const ext = rand() < 0.7 ? ".ts" : ".tsx"
      const id = `f${fileIdx++}`
      const n = makeNode(
        id,
        `src/${prefix}${ext}`,
        "File",
        `${prefix} layer for ${repo.name}`,
        repo.id,
      )
      repoFiles.push(n)
      nodes.push(n)
      links.push({ source: repo.id, target: id, type: "related_to" })
    }

    // Classes
    const repoClasses: GraphNodeForRender[] = []
    classesByRepo[repo.id] = repoClasses
    for (let c = 0; c < classCount; c++) {
      const prefix = pick(CLASS_PREFIXES, rand)
      const domain = repo.name.split("-")[0]
      const name = `${domain.charAt(0).toUpperCase()}${domain.slice(1)}${prefix}`
      const id = `c${classIdx++}`
      const file = pick(repoFiles, rand)
      const n = makeNode(id, name, "Class", `${prefix} for ${repo.name}`, repo.id)
      repoClasses.push(n)
      nodes.push(n)
      links.push({ source: file.id, target: id, type: "related_to" })

      // Classes mention 1-3 concepts
      const classConcepts = pickN(conceptNodes, conceptCount, rand)
      for (const concept of classConcepts) {
        links.push({ source: id, target: concept.id, type: "mentions" })
      }
    }

    // Functions
    const repoFuncs: GraphNodeForRender[] = []
    funcsByRepo[repo.id] = repoFuncs
    for (let fn = 0; fn < funcCount; fn++) {
      const verb = pick(FUNCTION_PREFIXES, rand)
      const domain = repo.name.split("-")[0]
      const noun = domain.charAt(0).toUpperCase() + domain.slice(1)
      const id = `fn${funcIdx++}`
      const file = pick(repoFiles, rand)
      const n = makeNode(id, `${verb}${noun}()`, "Function", `${verb} operation in ${repo.name}`, repo.id)
      repoFuncs.push(n)
      nodes.push(n)
      links.push({ source: file.id, target: id, type: "related_to" })
    }

    // Functions mention functions within the same repo (avg ~3 callees each)
    for (const fn of repoFuncs) {
      const callCount = 1 + Math.floor(rand() * 5)
      const callees = pickN(repoFuncs.filter((f) => f.id !== fn.id), callCount, rand)
      for (const callee of callees) {
        links.push({ source: fn.id, target: callee.id, type: "mentions" })
      }
    }

    // Intra-repo file imports (each file imports 1-4 other files in the same repo)
    for (const file of repoFiles) {
      const importCount = 1 + Math.floor(rand() * 4)
      const imported = pickN(repoFiles.filter((f) => f.id !== file.id), importCount, rand)
      for (const imp of imported) {
        links.push({ source: file.id, target: imp.id, type: "mentions" })
      }
    }
  }

  // ── Cross-repo calls (service mesh simulation) ─────────────────────────
  // ~18% of all functions call a function in another repo, and ~6% call a
  // second one — simulates service clients, SDK calls, shared library usage.
  const allFuncs = Object.values(funcsByRepo).flat()
  const allRepoIds = repoNodes.map((r) => r.id)

  for (const fn of allFuncs) {
    const crossCalls = (rand() < 0.18 ? 1 : 0) + (rand() < 0.06 ? 1 : 0)
    for (let x = 0; x < crossCalls; x++) {
      const targetRepoId = pick(allRepoIds.filter((id) => id !== fn.repository), rand)
      const targetFuncs = funcsByRepo[targetRepoId]
      if (targetFuncs?.length) {
        const target = pick(targetFuncs, rand)
        links.push({ source: fn.id, target: target.id, type: "mentions" })
      }
    }
  }

  // ── Cross-repo class dependencies (shared libs, auth clients, etc.) ─────
  const allClasses = Object.values(classesByRepo).flat()
  for (const cls of allClasses) {
    if (rand() < 0.14) {
      const targetRepoId = pick(
        allRepoIds.filter((id) => id !== cls.repository),
        rand,
      )
      const targetClasses = classesByRepo[targetRepoId]
      if (targetClasses?.length) {
        const target = pick(targetClasses, rand)
        links.push({ source: cls.id, target: target.id, type: "related_to" })
      }
    }
  }

  return { nodes, links }
}

const { nodes: STUB_NODES, links: STUB_LINKS } = generate()

export { STUB_NODES, STUB_LINKS }
