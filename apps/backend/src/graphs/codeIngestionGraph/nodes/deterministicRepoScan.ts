/**
 * Deterministic repository scanning for code-ingestion extractors.
 * Parses manifests, config files, and well-known paths without LLM agents.
 */

import { parse as parseYaml } from "yaml"
import { filterPathsByPartialScan } from "./partialIngestionScope.js"

export type WorkspaceDependency = {
  consumerPath: string
  providerPath: string
  evidence: string
}

export type ManifestLibrary = {
  name: string
  path: string
  category?: string
  evidence: string
}

export type ManifestDatabase = {
  dbType: string
  path: string
  evidence: string
}

export type ManifestInfrastructure = {
  infraType: string
  path: string
  evidence: string
}

export type ManifestStream = {
  streamType: string
  path: string
  role: "producer" | "consumer" | "both"
  evidence: string
}

const PACKAGE_JSON = "package.json"
const MANIFEST_FILES = new Set([
  PACKAGE_JSON,
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "mix.exs",
])

const PRISMA_SCHEMA_SUFFIX = "schema.prisma"
const DOCKER_COMPOSE_RE = /(^|\/)docker-compose[^/]*\.ya?ml$/i
const K8S_MANIFEST_RE = /(^|\/)(k8s|manifests|kubernetes)\/.*\.ya?ml$/i

type LibraryRule = {
  canonical: string
  category: string
  packages: string[]
}

const LIBRARY_RULES: LibraryRule[] = [
  {
    canonical: "Prisma",
    category: "ORM",
    packages: ["prisma", "@prisma/client"],
  },
  {
    canonical: "Drizzle",
    category: "ORM",
    packages: ["drizzle-orm", "drizzle-kit"],
  },
  { canonical: "TypeORM", category: "ORM", packages: ["typeorm"] },
  { canonical: "Sequelize", category: "ORM", packages: ["sequelize"] },
  { canonical: "Mongoose", category: "ORM", packages: ["mongoose"] },
  { canonical: "SQLAlchemy", category: "ORM", packages: ["sqlalchemy"] },
  { canonical: "GORM", category: "ORM", packages: ["gorm.io/gorm"] },
  { canonical: "Express", category: "HTTP", packages: ["express"] },
  { canonical: "Hono", category: "HTTP", packages: ["hono"] },
  { canonical: "Fastify", category: "HTTP", packages: ["fastify"] },
  { canonical: "Next.js", category: "HTTP", packages: ["next"] },
  { canonical: "FastAPI", category: "HTTP", packages: ["fastapi"] },
  { canonical: "Flask", category: "HTTP", packages: ["flask"] },
  { canonical: "Django", category: "HTTP", packages: ["django"] },
  { canonical: "Axum", category: "HTTP", packages: ["axum"] },
  {
    canonical: "Better Auth",
    category: "auth",
    packages: ["better-auth"],
  },
  { canonical: "NextAuth", category: "auth", packages: ["next-auth"] },
  { canonical: "Passport", category: "auth", packages: ["passport"] },
  { canonical: "Zod", category: "validation", packages: ["zod"] },
  { canonical: "Yup", category: "validation", packages: ["yup"] },
  { canonical: "Joi", category: "validation", packages: ["joi"] },
  { canonical: "Pydantic", category: "validation", packages: ["pydantic"] },
  { canonical: "ioredis", category: "cache", packages: ["ioredis"] },
  {
    canonical: "Upstash Redis",
    category: "cache",
    packages: ["@upstash/redis"],
  },
  { canonical: "tRPC", category: "RPC/API", packages: ["@trpc/server", "trpc"] },
  { canonical: "Axios", category: "HTTP", packages: ["axios"] },
  {
    canonical: "TanStack Query",
    category: "HTTP",
    packages: ["@tanstack/react-query", "@tanstack/vue-query"],
  },
]

const DATABASE_PACKAGE_RULES: Array<{ dbType: string; packages: string[] }> = [
  { dbType: "Postgres", packages: ["pg", "postgres", "@prisma/adapter-pg"] },
  { dbType: "MySQL", packages: ["mysql2", "mysql"] },
  { dbType: "SQLite", packages: ["better-sqlite3", "sqlite3"] },
  { dbType: "Mongo", packages: ["mongoose", "mongodb", "@prisma/adapter-mongo"] },
  {
    dbType: "Redis",
    packages: ["ioredis", "@upstash/redis", "redis"],
  },
  {
    dbType: "DynamoDB",
    packages: ["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb"],
  },
  { dbType: "Supabase", packages: ["@supabase/supabase-js"] },
]

const STREAM_PACKAGE_RULES: Array<{
  streamType: string
  packages: string[]
}> = [
  {
    streamType: "Kafka",
    packages: [
      "kafkajs",
      "kafka-node",
      "node-rdkafka",
      "@nestjs/microservices",
      "confluent-kafka",
      "kafka-python",
      "aiokafka",
    ],
  },
  {
    streamType: "RabbitMQ",
    packages: ["amqplib", "amqp", "pika", "@golevelup/nestjs-rabbitmq"],
  },
  { streamType: "SQS", packages: ["@aws-sdk/client-sqs"] },
  { streamType: "SNS", packages: ["@aws-sdk/client-sns"] },
  { streamType: "NATS", packages: ["nats", "nats.js"] },
  { streamType: "Pulsar", packages: ["pulsar-client", "@apache/pulsar-client-node"] },
  {
    streamType: "Google Pub/Sub",
    packages: ["@google-cloud/pubsub"],
  },
  {
    streamType: "Azure Event Hubs",
    packages: ["@azure/event-hubs"],
  },
]

const INFRA_FILE_RULES: Array<{
  test: (path: string) => boolean
  infraType: string
}> = [
  {
    test: (p) => /(^|\/)Dockerfile$/.test(p),
    infraType: "Docker",
  },
  {
    test: (p) => DOCKER_COMPOSE_RE.test(p),
    infraType: "Docker Compose",
  },
  {
    test: (p) => /(^|\/)Chart\.yaml$/.test(p),
    infraType: "Helm",
  },
  {
    test: (p) => /(^|\/)serverless\.ya?ml$/.test(p),
    infraType: "Serverless",
  },
  {
    test: (p) => /(^|\/)sam\.ya?ml$/.test(p) || /(^|\/)template\.ya?ml$/.test(p),
    infraType: "Lambda",
  },
  {
    test: (p) => /(^|\/)cloudbuild\.ya?ml$/.test(p),
    infraType: "Cloud Run",
  },
  {
    test: (p) => /\.tf$/.test(p),
    infraType: "Terraform",
  },
  {
    test: (p) => /(^|\/)Pulumi\.ya?ml$/.test(p),
    infraType: "Pulumi",
  },
  {
    test: (p) => /(^|\/)wrangler\.toml$/.test(p),
    infraType: "Cloudflare Workers",
  },
  {
    test: (p) => /(^|\/)vercel\.json$/.test(p),
    infraType: "Vercel",
  },
  {
    test: (p) => /(^|\/)fly\.toml$/.test(p),
    infraType: "Fly.io",
  },
  {
    test: (p) => /(^|\/)railway\.(json|toml)$/.test(p),
    infraType: "Railway",
  },
  {
    test: (p) => /(^|\/)render\.ya?ml$/.test(p),
    infraType: "Render",
  },
]

function basename(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? path : path.slice(i + 1)
}

export function dirOf(filePath: string): string {
  const i = filePath.lastIndexOf("/")
  return i === -1 ? "./" : filePath.slice(0, i)
}

function normalizePathSegments(segments: string[]): string {
  const stack: string[] = []
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      stack.pop()
      continue
    }
    stack.push(seg)
  }
  return stack.length === 0 ? "./" : stack.join("/")
}

export function resolveRelativePath(fromDir: string, relative: string): string {
  const base = fromDir === "./" ? [] : fromDir.split("/")
  return normalizePathSegments([...base, ...relative.split("/")])
}

function isWorkspaceRef(version: string): boolean {
  return (
    version.startsWith("workspace:") ||
    version.startsWith("link:") ||
    version.startsWith("file:")
  )
}

function parseJsonRecord(
  content: string,
): Record<string, string> | null {
  try {
    const parsed = JSON.parse(content) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    return {
      ...parsed.dependencies,
      ...parsed.devDependencies,
      ...parsed.peerDependencies,
      ...parsed.optionalDependencies,
    }
  } catch {
    return null
  }
}

export function pathsUnderRoot(allPaths: string[], root: string): string[] {
  if (root === "./") return allPaths
  const prefix = `${root}/`
  return allPaths.filter((p) => p === root || p.startsWith(prefix))
}

export function packageJsonPaths(allPaths: string[]): string[] {
  return allPaths.filter((p) => basename(p) === PACKAGE_JSON)
}

export function manifestPaths(allPaths: string[]): string[] {
  return allPaths.filter((p) => MANIFEST_FILES.has(basename(p)))
}

export function prismaSchemaPaths(allPaths: string[]): string[] {
  return allPaths.filter((p) => p.endsWith(PRISMA_SCHEMA_SUFFIX))
}

export function infrastructureCandidatePaths(allPaths: string[]): string[] {
  return allPaths.filter((p) =>
    INFRA_FILE_RULES.some((rule) => rule.test(p)),
  )
}

export function k8sManifestPaths(allPaths: string[]): string[] {
  return allPaths.filter(
    (p) => K8S_MANIFEST_RE.test(p) || /\.ya?ml$/.test(p),
  )
}

export function buildPackageNameIndex(
  packageJsonPathsList: string[],
  contents: Record<string, string>,
): Map<string, string> {
  const index = new Map<string, string>()
  for (const path of packageJsonPathsList) {
    try {
      const pkg = JSON.parse(contents[path] ?? "") as { name?: string }
      if (typeof pkg.name === "string" && pkg.name.length > 0) {
        index.set(pkg.name, dirOf(path))
      }
    } catch {
      // skip invalid package.json
    }
  }
  return index
}

function resolveProviderPath(
  depName: string,
  version: string,
  consumerDir: string,
  packageIndex: Map<string, string>,
): string | null {
  if (version.startsWith("file:")) {
    const rel = version.slice("file:".length)
    return resolveRelativePath(consumerDir, rel)
  }
  if (version.startsWith("link:")) {
    const rel = version.slice("link:".length)
    return resolveRelativePath(consumerDir, rel)
  }
  return packageIndex.get(depName) ?? null
}

export function scanWorkspaceDependencies(
  packageJsonPathsList: string[],
  contents: Record<string, string>,
  packageIndex: Map<string, string>,
): WorkspaceDependency[] {
  const deps: WorkspaceDependency[] = []
  const seen = new Set<string>()

  for (const path of packageJsonPathsList) {
    const consumerDir = dirOf(path)
    const allDeps = parseJsonRecord(contents[path] ?? "")
    if (!allDeps) continue

    for (const [name, version] of Object.entries(allDeps)) {
      if (!isWorkspaceRef(version)) continue
      const providerPath = resolveProviderPath(
        name,
        version,
        consumerDir,
        packageIndex,
      )
      if (!providerPath) continue

      const key = `${consumerDir}->${providerPath}`
      if (seen.has(key)) continue
      seen.add(key)

      deps.push({
        consumerPath: consumerDir,
        providerPath,
        evidence: `${path}: ${name}@${version}`,
      })
    }
  }

  return deps
}

function matchLibraryRule(packageName: string): LibraryRule | null {
  const lower = packageName.toLowerCase()
  for (const rule of LIBRARY_RULES) {
    if (rule.packages.some((p) => p.toLowerCase() === lower)) return rule
  }
  return null
}

function collectPackageNamesFromManifest(
  path: string,
  content: string,
): string[] {
  const base = basename(path)
  if (base === PACKAGE_JSON) {
    const deps = parseJsonRecord(content)
    return deps ? Object.keys(deps) : []
  }
  if (base === "requirements.txt") {
    return content
      .split("\n")
      .map((line) => line.trim().split(/[<>=!~\[]/)[0]?.trim() ?? "")
      .filter(Boolean)
  }
  if (base === "pyproject.toml") {
    const names: string[] = []
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*["']?([a-zA-Z0-9_.-]+)["']?\s*=/)
      if (m?.[1] && !["project", "tool", "build-system"].includes(m[1]))
        names.push(m[1])
    }
    return names
  }
  if (base === "go.mod") {
    return [...content.matchAll(/^\s+([^\s]+)\s+v[\d.]/gm)].map((m) => m[1] ?? "")
  }
  if (base === "Cargo.toml") {
    return [...content.matchAll(/^([a-zA-Z0-9_-]+)\s*=\s*/gm)].map(
      (m) => m[1] ?? "",
    )
  }
  if (base === "Gemfile") {
    return [...content.matchAll(/gem\s+['"]([^'"]+)['"]/g)].map(
      (m) => m[1] ?? "",
    )
  }
  if (base === "composer.json") {
    const deps = parseJsonRecord(content)
    return deps ? Object.keys(deps) : []
  }
  return []
}

export function scanLibraries(
  manifestPathsList: string[],
  contents: Record<string, string>,
): ManifestLibrary[] {
  const libs: ManifestLibrary[] = []
  const seen = new Set<string>()

  for (const path of manifestPathsList) {
    const rootPath = dirOf(path)
    const names = collectPackageNamesFromManifest(path, contents[path] ?? "")
    for (const pkg of names) {
      const rule = matchLibraryRule(pkg)
      if (!rule) continue
      const key = `${rootPath}:${rule.canonical}`
      if (seen.has(key)) continue
      seen.add(key)
      libs.push({
        name: rule.canonical,
        path: rootPath,
        category: rule.category,
        evidence: `${path}: ${pkg}`,
      })
    }
  }

  return libs
}

function normalizeDbTypeFromProvider(provider: string): string | null {
  const lower = provider.toLowerCase()
  if (lower.includes("postgres") || lower === "pg") return "Postgres"
  if (lower.includes("mysql")) return "MySQL"
  if (lower.includes("sqlite")) return "SQLite"
  if (lower.includes("mongo")) return "Mongo"
  if (lower.includes("cockroach")) return "CockroachDB"
  if (lower.includes("sqlserver") || lower.includes("mssql")) return "SQL Server"
  return null
}

function scanPrismaSchema(path: string, content: string): ManifestDatabase[] {
  const match = content.match(/provider\s*=\s*["']([^"']+)["']/)
  if (!match?.[1]) return []
  const dbType = normalizeDbTypeFromProvider(match[1])
  if (!dbType) return []
  return [
    {
      dbType,
      path: dirOf(path),
      evidence: `${path}: provider=${match[1]}`,
    },
  ]
}

function scanDockerCompose(path: string, content: string): ManifestDatabase[] {
  const dbs: ManifestDatabase[] = []
  const seen = new Set<string>()
  const rootPath = dirOf(path)

  let doc: unknown
  try {
    doc = parseYaml(content)
  } catch {
    return dbs
  }

  const services =
    typeof doc === "object" && doc !== null
      ? (doc as { services?: Record<string, { image?: string }> }).services
      : undefined
  if (!services) return dbs

  for (const [name, svc] of Object.entries(services)) {
    const image = (svc?.image ?? name).toLowerCase()
    let dbType: string | null = null
    if (image.includes("postgres")) dbType = "Postgres"
    else if (image.includes("mysql") || image.includes("mariadb"))
      dbType = "MySQL"
    else if (image.includes("mongo")) dbType = "Mongo"
    else if (image.includes("redis")) dbType = "Redis"
    else if (image.includes("cockroach")) dbType = "CockroachDB"
    if (!dbType || seen.has(dbType)) continue
    seen.add(dbType)
    dbs.push({
      dbType,
      path: rootPath,
      evidence: `${path}: service ${name}`,
    })
  }

  return dbs
}

function scanPackageJsonDatabases(
  path: string,
  content: string,
): ManifestDatabase[] {
  const deps = parseJsonRecord(content)
  if (!deps) return []
  const rootPath = dirOf(path)
  const dbs: ManifestDatabase[] = []
  const seen = new Set<string>()

  for (const [pkg, rule] of Object.entries(
    Object.fromEntries(
      DATABASE_PACKAGE_RULES.flatMap((r) =>
        r.packages.map((p) => [p.toLowerCase(), r.dbType] as const),
      ),
    ),
  )) {
    if (!Object.keys(deps).some((d) => d.toLowerCase() === pkg)) continue
    if (seen.has(rule)) continue
    seen.add(rule)
    dbs.push({
      dbType: rule,
      path: rootPath,
      evidence: `${path}: ${pkg}`,
    })
  }

  return dbs
}

export function scanDatabases(
  allPaths: string[],
  contents: Record<string, string>,
): ManifestDatabase[] {
  const dbs: ManifestDatabase[] = []
  const seen = new Set<string>()

  const add = (entries: ManifestDatabase[]) => {
    for (const entry of entries) {
      const key = `${entry.path}:${entry.dbType}`
      if (seen.has(key)) continue
      seen.add(key)
      dbs.push(entry)
    }
  }

  for (const path of prismaSchemaPaths(allPaths)) {
    add(scanPrismaSchema(path, contents[path] ?? ""))
  }

  for (const path of allPaths.filter((p) => DOCKER_COMPOSE_RE.test(p))) {
    add(scanDockerCompose(path, contents[path] ?? ""))
  }

  for (const path of packageJsonPaths(allPaths)) {
    add(scanPackageJsonDatabases(path, contents[path] ?? ""))
  }

  return dbs
}

function isKubernetesManifest(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed) return false
  return (
    /apiVersion:\s*\S+/m.test(trimmed) &&
    /kind:\s*(Deployment|StatefulSet|DaemonSet|Service|Ingress|ConfigMap)/m.test(
      trimmed,
    )
  )
}

export function scanInfrastructure(
  allPaths: string[],
  contents: Record<string, string>,
): ManifestInfrastructure[] {
  const infra: ManifestInfrastructure[] = []
  const seen = new Set<string>()

  for (const path of allPaths) {
    for (const rule of INFRA_FILE_RULES) {
      if (!rule.test(path)) continue
      const rootPath = dirOf(path)
      const key = `${rootPath}:${rule.infraType}`
      if (seen.has(key)) continue
      seen.add(key)
      infra.push({
        infraType: rule.infraType,
        path: rootPath === "./" ? path : rootPath,
        evidence: path,
      })
      break
    }
  }

  for (const path of k8sManifestPaths(allPaths)) {
    const content = contents[path] ?? ""
    if (!isKubernetesManifest(content)) continue
    const rootPath = dirOf(path)
    const key = `${rootPath}:Kubernetes`
    if (seen.has(key)) continue
    seen.add(key)
    infra.push({
      infraType: "Kubernetes",
      path: rootPath === "./" ? path : rootPath,
      evidence: path,
    })
  }

  return infra
}

export function scanStreams(
  manifestPathsList: string[],
  contents: Record<string, string>,
): ManifestStream[] {
  const streams: ManifestStream[] = []
  const seen = new Set<string>()

  for (const path of manifestPathsList) {
    const rootPath = dirOf(path)
    const names = collectPackageNamesFromManifest(path, contents[path] ?? "")
    const lowerNames = new Set(names.map((n) => n.toLowerCase()))

    for (const rule of STREAM_PACKAGE_RULES) {
      const matched = rule.packages.find((p) => lowerNames.has(p.toLowerCase()))
      if (!matched) continue
      const key = `${rootPath}:${rule.streamType}`
      if (seen.has(key)) continue
      seen.add(key)
      streams.push({
        streamType: rule.streamType,
        path: rootPath,
        role: "both",
        evidence: `${path}: ${matched}`,
      })
    }

    if (
      lowerNames.has("ioredis") ||
      lowerNames.has("redis") ||
      lowerNames.has("redis-py")
    ) {
      const key = `${rootPath}:Redis Pub/Sub`
      if (!seen.has(key)) {
        seen.add(key)
        streams.push({
          streamType: "Redis Pub/Sub",
          path: rootPath,
          role: "both",
          evidence: `${path}: redis pub/sub dependency`,
        })
      }
    }
  }

  return streams
}

/** Collect unique file paths needed for deterministic extraction scans. */
export function collectDeterministicScanPaths(
  allPaths: string[],
  scanPaths: string[],
): string[] {
  const scoped =
    scanPaths.length > 0 ? filterPathsByPartialScan(allPaths, scanPaths) : allPaths

  const needed = new Set<string>()
  for (const p of packageJsonPaths(scoped)) needed.add(p)
  for (const p of manifestPaths(scoped)) needed.add(p)
  for (const p of prismaSchemaPaths(scoped)) needed.add(p)
  for (const p of infrastructureCandidatePaths(scoped)) needed.add(p)
  for (const p of k8sManifestPaths(scoped)) needed.add(p)
  for (const p of scoped.filter((path) => DOCKER_COMPOSE_RE.test(path)))
    needed.add(p)

  return [...needed]
}
