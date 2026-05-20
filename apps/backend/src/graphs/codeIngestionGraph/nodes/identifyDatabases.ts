import { HumanMessage } from "@langchain/core/messages"
import { tool } from "langchain"
import { z } from "zod/v3"
import { requireCurrentOrgId } from "../../../auth/context.js"
import { getLogger } from "../../../observability/logger.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import {
  REPO_EXPLORER_TOOLS_HINT,
  standardRepoExplorerTools,
} from "../../../tools/repoExplorerTools.js"
import { createAgent } from "../../createAgent.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"
import {
  partialScanPathsForExtractors,
  partialScanPromptSuffix,
  repoPathMatchesPartialScan,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"

function pathMatchesRoot(path: string, root: string): boolean {
  if (root === "./") return true
  return path.startsWith(`${root}/`) || path === root
}

/** Normalize dbType to canonical form for deduplication */
function normalizeDbType(dbType: string): string {
  const lower = dbType.toLowerCase()
  if (lower.includes("postgres") || lower === "pg") return "Postgres"
  if (lower.includes("mysql")) return "MySQL"
  if (lower.includes("sqlite")) return "SQLite"
  if (lower.includes("mongo")) return "Mongo"
  if (lower.includes("redis")) return "Redis"
  if (lower.includes("dynamo")) return "DynamoDB"
  if (lower.includes("supabase")) return "Supabase"
  if (lower.includes("cassandra")) return "Cassandra"
  if (lower.includes("cockroach")) return "CockroachDB"
  return dbType
}

type SubmittedDatabase = {
  dbType: string
  path: string
  evidence?: string
}

function createIdentifyDatabasesTools(capturedDbs: {
  value: SubmittedDatabase[]
}) {
  const submitDatabasesTool = tool(
    async ({ databases }) => {
      capturedDbs.value.push(...databases)
      return `Recorded ${databases.length} database(s). Total: ${capturedDbs.value.length}.`
    },
    {
      name: "submit_databases",
      description: `Call this when you have discovered one or more databases used by the codebase. For each database provide dbType (e.g. Postgres, Mongo, Redis, MySQL, SQLite), path (root or directory where it's used, e.g. apps/web or apps/web/prisma), and optional evidence (brief description of how you found it).`,
      schema: z.object({
        databases: z.array(
          z.object({
            dbType: z
              .string()
              .describe(
                "Database type: Postgres, MySQL, SQLite, Mongo, Redis, DynamoDB, Supabase, Cassandra, CockroachDB, etc.",
              ),
            path: z
              .string()
              .describe(
                "Root or directory path where database is used, e.g. apps/web or .",
              ),
            evidence: z
              .string()
              .optional()
              .describe(
                "Brief evidence, e.g. Prisma schema provider postgresql",
              ),
          }),
        ),
      }),
    },
  )
  return [...standardRepoExplorerTools, submitDatabasesTool]
}

const SYSTEM_PROMPT = `You are analyzing a repository to detect all databases used by the codebase. Look across any language — JavaScript, TypeScript, Python, Go, Java, Kotlin, Ruby, PHP, C#, Rust, Elixir, Swift, and others. Do not assume a single stack.

Config files to inspect (per language):
| Language / ecosystem | Config / schema files |
| JS/TS (Node, Bun)    | package.json, prisma/schema.prisma, drizzle.config.* |
| Python               | requirements.txt, pyproject.toml, Pipfile, settings.py, alembic.ini |
| Go                   | go.mod, go.sum |
| Java / Kotlin        | pom.xml, build.gradle, build.gradle.kts, application.yml, application.properties |
| Ruby                 | Gemfile, database.yml, config/database.yml |
| PHP                  | composer.json, .env.example, config/database.php |
| C# / .NET            | *.csproj, appsettings.json, DbContext |
| Rust                 | Cargo.toml |
| Elixir               | mix.exs, config/*.exs |
| Swift                | Package.swift |

Database types and detection hints:
| Database       | Detection hints |
| PostgreSQL     | postgresql://, postgres://, provider = "postgresql", create_engine("postgresql"), psycopg2, pgx, pg package, jdbc:postgresql, DATABASE_URL with postgres |
| MySQL          | mysql://, mysql2, pymysql, create_engine("mysql"), jdbc:mysql, GORM mysql |
| SQLite         | sqlite://, sqlite3, better-sqlite3, .db files, provider = "sqlite" |
| MongoDB        | mongodb://, mongoose, pymongo, Motor, MongoClient, @prisma/adapter-mongo |
| Redis          | redis://, ioredis, redis-py, go-redis, @upstash/redis, StackExchange.Redis |
| DynamoDB       | @aws-sdk/client-dynamodb, boto3 dynamodb |
| Supabase       | @supabase/supabase-js, supabase-py |
| Cassandra      | cassandra-driver, gocql |
| CockroachDB    | cockroachdb://, pgx with cockroach |

Search strategy:
1. list_files at each root for prisma/, schema.prisma, package.json, requirements.txt, pyproject.toml, go.mod, pom.xml, Gemfile, composer.json, Cargo.toml, mix.exs, .env.example
2. search for connection strings, ORM config, driver imports (postgresql, create_engine, SessionLocal, DATABASES, jdbc:, mongodb://, redis://)
3. get_file on schema files, package manifests, env examples to confirm

For each database found, call submit_databases with dbType, path (root or directory), and optional evidence. Be thorough. Explore all roots. Prefer submit_databases once connection/ORM evidence is clear.`

export async function identifyDatabases(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, roots = ["./"], targetHash } = state
  requireCurrentOrgId()

  if (shouldSkipExtractorForPartialDeletesOnly(state)) {
    return {}
  }

  const scanPaths = partialScanPathsForExtractors(state)
  const scopeHint =
    state.ingestMode === "partial" && scanPaths.length > 0
      ? partialScanPromptSuffix(scanPaths)
      : ""

  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []

  const capturedDbs: { value: SubmittedDatabase[] } = { value: [] }
  const tools = createIdentifyDatabasesTools(capturedDbs)
  const agent = createAgent({
    model: getModel("medium", { temperature: 0.1 }),
    tools,
    contextMiddleware: {
      clearToolUsesTriggerTokens: 140_000,
      clearToolUsesKeepMessages: 14,
      summarizationTriggerTokens: 220_000,
      summarizationKeepMessages: 32,
    },
    systemPrompt: `${SYSTEM_PROMPT}

Use repositoryId "${repositoryId}" for all tool calls. Roots to explore: ${roots.join(", ")}.

${REPO_EXPLORER_TOOLS_HINT}${scopeHint}`,
  })

  const userMessage = `Explore the repository for databases. List files in config directories, search for database connection patterns across all languages. For each database found, read the relevant config/schema to confirm, then call submit_databases.`

  await agent.invoke(
    { messages: [new HumanMessage(userMessage)] },
    {
      recursionLimit: 180,
    },
  )

  if (capturedDbs.value.length === 0) {
    getLogger().warn(
      "identifyDatabases: agent completed without submit_databases (no databases captured)",
      { repositoryId, targetHash },
    )
  }

  let submissions = capturedDbs.value
  if (state.ingestMode === "partial" && scanPaths.length > 0) {
    submissions = submissions.filter((db) =>
      repoPathMatchesPartialScan(db.path, scanPaths),
    )
  }

  const seenDbs = new Set<string>()
  for (const root of roots) {
    const svcDeduplicationKey = `svc:${repositoryId}:${root}`
    for (const db of submissions) {
      if (!pathMatchesRoot(db.path, root)) continue
      const dbType = normalizeDbType(db.dbType)
      const dedupKey = `db:${repositoryId}:${root}:${dbType}`
      if (seenDbs.has(dedupKey)) continue
      seenDbs.add(dedupKey)

      objects.push({
        kind: "Database",
        deduplicationKey: dedupKey,
        name: dbType,
        summary: `${dbType} used by ${root}`,
      })

      claims.push({
        subjectRef: svcDeduplicationKey,
        subjectKind: "Service",
        objectRef: dedupKey,
        objectKind: "Database",
        predicate: "DEPENDS_ON",
        sourceId: `identifyDatabases:${repositoryId}:${root}:${dbType}:${targetHash}`,
        sourceType: "git",
        extractionMethod: "llm",
        confidence: 0.8,
        provenance: { root, dbType, evidence: db.evidence },
      })
    }
  }

  return {
    extractedObjects: objects,
    extractedClaims: claims,
  }
}
