import {
  fetchFiles,
  listFilesRecursive,
} from "../../../domain/codeIngestion/codesearchClient.js"
import { repoPathMatchesPartialScan } from "./partialIngestionScope.js"

export type DatabaseSignalKind =
  | "connection-string"
  | "provider-config"
  | "client-initialization"
  | "driver-dependency"

export type DeterministicDatabaseEvidence = {
  signalKind: DatabaseSignalKind
  filePath: string
  detail: string
}

export type DeterministicDatabaseCandidate = {
  root: string
  dbType: string
  normalizedDbType: string
  confidence: number
  evidence: DeterministicDatabaseEvidence[]
  signalKinds: DatabaseSignalKind[]
  matchedFiles: string[]
  scoreBreakdown: Partial<Record<DatabaseSignalKind, number>>
}

export type DeterministicDatabasesResult = {
  accepted: DeterministicDatabaseCandidate[]
  ambiguous: DeterministicDatabaseCandidate[]
  unresolvedRoots: string[]
  scanErrors: { root: string; error: string }[]
}

type DeterministicScanInput = {
  repositoryId: string
  orgId: string
  roots: string[]
  scanPaths: string[]
}

type EvidenceAccumulator = {
  evidence: DeterministicDatabaseEvidence[]
  scoreBreakdown: Partial<Record<DatabaseSignalKind, number>>
}

const SIGNAL_POINTS: Record<DatabaseSignalKind, number> = {
  "connection-string": 0.6,
  "provider-config": 0.6,
  "client-initialization": 0.25,
  "driver-dependency": 0.15,
}

const DETERMINISTIC_ACCEPT_THRESHOLD = 0.85
const DETERMINISTIC_AMBIGUOUS_THRESHOLD = 0.6

const MANIFEST_FILE_NAMES = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "pipfile",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "cargo.toml",
  "mix.exs",
  "composer.json",
  "gemfile",
])

const SOURCE_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".py",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".rs",
  ".ex",
  ".exs",
])

const SOURCE_PRIORITY_PATH_HINT = /db|database|prisma|drizzle|mongo|redis|dynamo|supabase|sql|orm|cache/i
const SOURCE_PRIORITY_BASENAME = new Set([
  "server.ts",
  "server.js",
  "app.ts",
  "app.js",
  "main.ts",
  "main.js",
  "index.ts",
  "index.js",
  "settings.py",
  "config.py",
])

const MAX_SOURCE_FILES_PER_ROOT = 140
const MAX_FILES_PER_ROOT = 220

const DB_ALIAS_MAP: Record<string, string> = {
  postgres: "Postgres",
  postgresql: "Postgres",
  pg: "Postgres",
  mysql: "MySQL",
  mariadb: "MySQL",
  sqlite: "SQLite",
  sqlite3: "SQLite",
  mongo: "Mongo",
  mongodb: "Mongo",
  redis: "Redis",
  dynamodb: "DynamoDB",
  supabase: "Supabase",
  cassandra: "Cassandra",
  cockroach: "CockroachDB",
  cockroachdb: "CockroachDB",
}

const CONNECTION_STRING_PATTERNS: Array<{
  dbType: string
  pattern: RegExp
  detail: string
}> = [
  {
    dbType: "Postgres",
    pattern: /\bpostgres(?:ql)?:\/\//i,
    detail: "postgres connection string",
  },
  {
    dbType: "MySQL",
    pattern: /\bmysql(?:\+\w+)?:\/\//i,
    detail: "mysql connection string",
  },
  {
    dbType: "SQLite",
    pattern: /\bsqlite(?:\+\w+)?:/i,
    detail: "sqlite connection string",
  },
  {
    dbType: "Mongo",
    pattern: /\bmongodb(?:\+srv)?:\/\//i,
    detail: "mongodb connection string",
  },
  {
    dbType: "Redis",
    pattern: /\bredis(?:\+\w+)?:\/\//i,
    detail: "redis connection string",
  },
  {
    dbType: "CockroachDB",
    pattern: /\bcockroach(?:db)?:\/\//i,
    detail: "cockroach connection string",
  },
]

const DEPENDENCY_TOKEN_MAP: Record<string, string> = {
  pg: "Postgres",
  "pgx/v5": "Postgres",
  psycopg2: "Postgres",
  psycopg: "Postgres",
  asyncpg: "Postgres",
  npgsql: "Postgres",
  mysql2: "MySQL",
  mysql: "MySQL",
  pymysql: "MySQL",
  mariadb: "MySQL",
  sqlite3: "SQLite",
  "better-sqlite3": "SQLite",
  mongoose: "Mongo",
  mongodb: "Mongo",
  pymongo: "Mongo",
  ioredis: "Redis",
  redis: "Redis",
  "@upstash/redis": "Redis",
  "go-redis/redis": "Redis",
  "@aws-sdk/client-dynamodb": "DynamoDB",
  "aws-sdk-dynamodb": "DynamoDB",
  "@supabase/supabase-js": "Supabase",
  "supabase-py": "Supabase",
  "cassandra-driver": "Cassandra",
  gocql: "Cassandra",
  cockroachdb: "CockroachDB",
}

const CLIENT_INIT_PATTERNS: Array<{ dbType: string; pattern: RegExp; detail: string }> =
  [
    {
      dbType: "Postgres",
      pattern: /\bfrom\s+["']pg["']|require\(\s*["']pg["']\s*\)|\bnew\s+(?:Pool|Client)\s*\(/i,
      detail: "pg client import or initialization",
    },
    {
      dbType: "MySQL",
      pattern: /\bfrom\s+["']mysql2?["']|require\(\s*["']mysql2?["']\s*\)|\bcreatePool\s*\([^)]*mysql/i,
      detail: "mysql client import or initialization",
    },
    {
      dbType: "Mongo",
      pattern: /\bMongoClient\b|\bfrom\s+["']mongodb["']|\bfrom\s+["']mongoose["']/i,
      detail: "mongodb client import or initialization",
    },
    {
      dbType: "Redis",
      pattern: /\bfrom\s+["']ioredis["']|\bnew\s+Redis\s*\(|\bcreateClient\s*\([^)]*redis/i,
      detail: "redis client import or initialization",
    },
    {
      dbType: "DynamoDB",
      pattern: /\bDynamoDBClient\b|\bfrom\s+["']@aws-sdk\/client-dynamodb["']/i,
      detail: "dynamodb client import or initialization",
    },
    {
      dbType: "Supabase",
      pattern: /\bcreateClient\s*\([^)]*supabase|from\s+["']@supabase\/supabase-js["']/i,
      detail: "supabase client import or initialization",
    },
  ]

function basename(path: string): string {
  const parts = path.split("/")
  return parts[parts.length - 1] ?? path
}

function fileExtension(path: string): string {
  const name = basename(path).toLowerCase()
  const idx = name.lastIndexOf(".")
  if (idx === -1) return ""
  return name.slice(idx)
}

function normalizeRootPath(root: string): string {
  if (root === "./" || root === ".") return ""
  return root
}

export function normalizeDbType(dbType: string): string {
  const lower = dbType.toLowerCase().trim()
  if (!lower) return dbType
  return DB_ALIAS_MAP[lower] ?? dbType
}

function isManifestPath(path: string): boolean {
  return MANIFEST_FILE_NAMES.has(basename(path).toLowerCase())
}

function isConfigPath(path: string): boolean {
  const lowerPath = path.toLowerCase()
  const lowerBase = basename(path).toLowerCase()
  return (
    lowerBase.startsWith(".env") ||
    lowerPath.endsWith("schema.prisma") ||
    lowerPath.includes("drizzle.config.") ||
    lowerPath.endsWith("alembic.ini") ||
    lowerPath.endsWith("application.yml") ||
    lowerPath.endsWith("application.yaml") ||
    lowerPath.endsWith("application.properties") ||
    lowerPath.endsWith("database.yml") ||
    lowerPath.endsWith("database.php") ||
    lowerPath.endsWith("appsettings.json") ||
    lowerPath.endsWith("settings.py")
  )
}

function isSourcePath(path: string): boolean {
  return SOURCE_FILE_EXTENSIONS.has(fileExtension(path))
}

function pickSourceFiles(paths: string[]): string[] {
  const sourcePaths = paths.filter((path) => isSourcePath(path))
  if (sourcePaths.length <= MAX_SOURCE_FILES_PER_ROOT) return sourcePaths
  const prioritized = sourcePaths.filter((path) => {
    const lower = path.toLowerCase()
    const base = basename(path).toLowerCase()
    return SOURCE_PRIORITY_PATH_HINT.test(lower) || SOURCE_PRIORITY_BASENAME.has(base)
  })
  return prioritized.slice(0, MAX_SOURCE_FILES_PER_ROOT)
}

function shouldScanPathForPartial(path: string, scanPaths: string[]): boolean {
  if (scanPaths.length === 0) return true
  return repoPathMatchesPartialScan(path, scanPaths)
}

function addEvidence(
  byDbType: Map<string, EvidenceAccumulator>,
  dbType: string,
  evidence: DeterministicDatabaseEvidence,
): void {
  const normalized = normalizeDbType(dbType)
  const existing = byDbType.get(normalized) ?? {
    evidence: [],
    scoreBreakdown: {},
  }

  existing.evidence.push(evidence)
  if (existing.scoreBreakdown[evidence.signalKind] === undefined) {
    existing.scoreBreakdown[evidence.signalKind] = SIGNAL_POINTS[evidence.signalKind]
  }

  byDbType.set(normalized, existing)
}

function detectConnectionStringSignals(
  content: string,
  filePath: string,
): Array<{ dbType: string; evidence: DeterministicDatabaseEvidence }> {
  const found: Array<{ dbType: string; evidence: DeterministicDatabaseEvidence }> =
    []
  for (const entry of CONNECTION_STRING_PATTERNS) {
    if (!entry.pattern.test(content)) continue
    found.push({
      dbType: entry.dbType,
      evidence: {
        signalKind: "connection-string",
        filePath,
        detail: entry.detail,
      },
    })
  }
  return found
}

function detectProviderSignals(
  content: string,
  filePath: string,
): Array<{ dbType: string; evidence: DeterministicDatabaseEvidence }> {
  const lowerPath = filePath.toLowerCase()
  const out: Array<{ dbType: string; evidence: DeterministicDatabaseEvidence }> = []

  if (lowerPath.endsWith("schema.prisma")) {
    const providerMatch = content.match(/provider\s*=\s*"([^"]+)"/i)
    if (providerMatch?.[1]) {
      out.push({
        dbType: providerMatch[1],
        evidence: {
          signalKind: "provider-config",
          filePath,
          detail: `prisma provider=${providerMatch[1]}`,
        },
      })
    }
  }

  if (lowerPath.includes("drizzle.config.")) {
    const dialectMatch = content.match(/dialect\s*:\s*["']([^"']+)["']/i)
    if (dialectMatch?.[1]) {
      out.push({
        dbType: dialectMatch[1],
        evidence: {
          signalKind: "provider-config",
          filePath,
          detail: `drizzle dialect=${dialectMatch[1]}`,
        },
      })
    }
  }

  const springJdbcMatch = content.match(/jdbc:(postgresql|mysql|sqlite|mariadb):/i)
  if (springJdbcMatch?.[1]) {
    out.push({
      dbType: springJdbcMatch[1],
      evidence: {
        signalKind: "provider-config",
        filePath,
        detail: `jdbc provider=${springJdbcMatch[1]}`,
      },
    })
  }

  const djangoEngineMatch = content.match(
    /django\.db\.backends\.(postgresql|mysql|sqlite3)/i,
  )
  if (djangoEngineMatch?.[1]) {
    out.push({
      dbType: djangoEngineMatch[1],
      evidence: {
        signalKind: "provider-config",
        filePath,
        detail: `django engine=${djangoEngineMatch[1]}`,
      },
    })
  }

  const railsAdapterMatch = content.match(/adapter:\s*(postgresql|mysql2|sqlite3)/i)
  if (railsAdapterMatch?.[1]) {
    out.push({
      dbType: railsAdapterMatch[1],
      evidence: {
        signalKind: "provider-config",
        filePath,
        detail: `rails adapter=${railsAdapterMatch[1]}`,
      },
    })
  }

  return out
}

function parsePackageJsonDependencies(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    const names = new Set<string>()
    for (const field of [
      parsed.dependencies,
      parsed.devDependencies,
      parsed.peerDependencies,
      parsed.optionalDependencies,
    ]) {
      if (!field) continue
      for (const dep of Object.keys(field)) {
        names.add(dep.toLowerCase())
      }
    }
    return Array.from(names)
  } catch {
    return []
  }
}

function detectDependencySignals(
  content: string,
  filePath: string,
): Array<{ dbType: string; evidence: DeterministicDatabaseEvidence }> {
  const lowerPath = filePath.toLowerCase()
  const out: Array<{ dbType: string; evidence: DeterministicDatabaseEvidence }> = []

  const dependencyTokens = new Set<string>()
  if (lowerPath.endsWith("package.json")) {
    for (const dep of parsePackageJsonDependencies(content)) {
      dependencyTokens.add(dep)
    }
  } else {
    const lowered = content.toLowerCase()
    for (const token of Object.keys(DEPENDENCY_TOKEN_MAP)) {
      if (lowered.includes(token)) {
        dependencyTokens.add(token)
      }
    }
  }

  for (const token of dependencyTokens) {
    const dbType = DEPENDENCY_TOKEN_MAP[token]
    if (!dbType) continue
    out.push({
      dbType,
      evidence: {
        signalKind: "driver-dependency",
        filePath,
        detail: `dependency token=${token}`,
      },
    })
  }

  return out
}

function detectClientSignals(
  content: string,
  filePath: string,
): Array<{ dbType: string; evidence: DeterministicDatabaseEvidence }> {
  const out: Array<{ dbType: string; evidence: DeterministicDatabaseEvidence }> = []
  for (const entry of CLIENT_INIT_PATTERNS) {
    if (!entry.pattern.test(content)) continue
    out.push({
      dbType: entry.dbType,
      evidence: {
        signalKind: "client-initialization",
        filePath,
        detail: entry.detail,
      },
    })
  }
  return out
}

function scoreCandidate(accumulator: EvidenceAccumulator): {
  confidence: number
  signalKinds: DatabaseSignalKind[]
  matchedFiles: string[]
  scoreBreakdown: Partial<Record<DatabaseSignalKind, number>>
} {
  const score = Object.values(accumulator.scoreBreakdown).reduce(
    (sum, points) => sum + (points ?? 0),
    0,
  )
  return {
    confidence: Math.min(1, Number(score.toFixed(2))),
    signalKinds: Object.keys(accumulator.scoreBreakdown) as DatabaseSignalKind[],
    matchedFiles: Array.from(new Set(accumulator.evidence.map((ev) => ev.filePath))),
    scoreBreakdown: accumulator.scoreBreakdown,
  }
}

function classifyRootCandidates(
  root: string,
  byDbType: Map<string, EvidenceAccumulator>,
): { accepted: DeterministicDatabaseCandidate[]; ambiguous: DeterministicDatabaseCandidate[] } {
  const accepted: DeterministicDatabaseCandidate[] = []
  const ambiguous: DeterministicDatabaseCandidate[] = []

  for (const [dbType, accumulator] of byDbType.entries()) {
    const scored = scoreCandidate(accumulator)
    const candidate: DeterministicDatabaseCandidate = {
      root,
      dbType,
      normalizedDbType: normalizeDbType(dbType),
      confidence: scored.confidence,
      evidence: accumulator.evidence,
      signalKinds: scored.signalKinds,
      matchedFiles: scored.matchedFiles,
      scoreBreakdown: scored.scoreBreakdown,
    }
    if (candidate.confidence >= DETERMINISTIC_ACCEPT_THRESHOLD) {
      accepted.push(candidate)
    } else if (candidate.confidence >= DETERMINISTIC_AMBIGUOUS_THRESHOLD) {
      ambiguous.push(candidate)
    }
  }

  return { accepted, ambiguous }
}

async function collectRootFilePaths(
  repositoryId: string,
  orgId: string,
  root: string,
): Promise<string[]> {
  return listFilesRecursive(repositoryId, orgId, normalizeRootPath(root))
}

function selectFilesForRoot(paths: string[]): string[] {
  const manifestsAndConfig = paths.filter(
    (path) => isManifestPath(path) || isConfigPath(path),
  )
  const sourceFiles = pickSourceFiles(paths)
  return Array.from(new Set([...manifestsAndConfig, ...sourceFiles])).slice(
    0,
    MAX_FILES_PER_ROOT,
  )
}

function detectSignalsForFile(
  byDbType: Map<string, EvidenceAccumulator>,
  filePath: string,
  content: string,
): void {
  for (const signal of detectConnectionStringSignals(content, filePath)) {
    addEvidence(byDbType, signal.dbType, signal.evidence)
  }

  for (const provider of detectProviderSignals(content, filePath)) {
    addEvidence(byDbType, provider.dbType, provider.evidence)
  }

  for (const dependency of detectDependencySignals(content, filePath)) {
    addEvidence(byDbType, dependency.dbType, dependency.evidence)
  }

  for (const client of detectClientSignals(content, filePath)) {
    addEvidence(byDbType, client.dbType, client.evidence)
  }
}

export async function deterministicDetectDatabases(
  input: DeterministicScanInput,
): Promise<DeterministicDatabasesResult> {
  const accepted: DeterministicDatabaseCandidate[] = []
  const ambiguous: DeterministicDatabaseCandidate[] = []
  const unresolvedRoots: string[] = []
  const scanErrors: { root: string; error: string }[] = []

  for (const root of input.roots) {
    let rootPaths: string[]
    try {
      rootPaths = await collectRootFilePaths(input.repositoryId, input.orgId, root)
    } catch (error) {
      unresolvedRoots.push(root)
      scanErrors.push({
        root,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    const pathsToInspect = selectFilesForRoot(rootPaths).filter((path) =>
      shouldScanPathForPartial(path, input.scanPaths),
    )
    if (pathsToInspect.length === 0) {
      unresolvedRoots.push(root)
      continue
    }

    let fileContents: Record<string, string>
    try {
      fileContents = await fetchFiles(input.repositoryId, input.orgId, pathsToInspect)
    } catch (error) {
      unresolvedRoots.push(root)
      scanErrors.push({
        root,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    const byDbType = new Map<string, EvidenceAccumulator>()
    for (const path of pathsToInspect) {
      const content = fileContents[path]
      if (!content) continue
      detectSignalsForFile(byDbType, path, content)
    }

    const classified = classifyRootCandidates(root, byDbType)
    accepted.push(...classified.accepted)
    ambiguous.push(...classified.ambiguous)
    if (classified.accepted.length === 0 && classified.ambiguous.length === 0) {
      unresolvedRoots.push(root)
    }
  }

  return {
    accepted,
    ambiguous,
    unresolvedRoots: Array.from(new Set(unresolvedRoots)),
    scanErrors,
  }
}
