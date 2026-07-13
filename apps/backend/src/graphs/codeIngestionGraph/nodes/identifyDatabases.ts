import { HumanMessage } from "@langchain/core/messages"
import { mergeConfigs } from "@langchain/core/runnables"
import { getConfig } from "@langchain/langgraph"
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
import { resolveSubmissionRoot } from "./extractionSubmissionRoot.js"
import {
  deterministicDetectDatabases,
  normalizeDbType,
} from "./identifyDatabasesDeterministic.js"
import {
  partialScanPathsForExtractors,
  partialScanPromptSuffix,
  repoPathMatchesPartialScan,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"

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
      capturedDbs.value.push(...(databases as SubmittedDatabase[]))
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

Cover only the listed roots. Call submit_databases for each database supported by ORM config, connection strings, or manifests; batch multiple databases per call. Prefer submitting once connection/ORM evidence is clear over exhaustive blind search.`

export async function identifyDatabases(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, orgId, roots = ["./"], targetHash } = state
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
  const seenDbs = new Set<string>()

  const deterministic = await deterministicDetectDatabases({
    repositoryId,
    orgId,
    roots,
    scanPaths: state.ingestMode === "partial" ? scanPaths : [],
  })

  for (const candidate of deterministic.accepted) {
    const dbType = normalizeDbType(candidate.dbType)
    const dedupKey = `db:${repositoryId}:${candidate.root}:${dbType}`
    if (seenDbs.has(dedupKey)) continue
    seenDbs.add(dedupKey)
    objects.push({
      kind: "Database",
      deduplicationKey: dedupKey,
      name: dbType,
      summary: `${dbType} used by ${candidate.root}`,
    })
    claims.push({
      subjectRef: `svc:${repositoryId}:${candidate.root}`,
      subjectKind: "Service",
      objectRef: dedupKey,
      objectKind: "Database",
      predicate: "DEPENDS_ON",
      sourceId: `identifyDatabases:${repositoryId}:${candidate.root}:${dbType}:${targetHash}`,
      sourceType: "git",
      extractionMethod: "deterministic",
      confidence: candidate.confidence,
      provenance: {
        root: candidate.root,
        dbType,
        normalizedDbType: candidate.normalizedDbType,
        signalKinds: candidate.signalKinds,
        matchedFiles: candidate.matchedFiles,
        scoreBreakdown: candidate.scoreBreakdown,
        evidence: candidate.evidence.map((entry) => ({
          signalKind: entry.signalKind,
          filePath: entry.filePath,
          detail: entry.detail,
        })),
      },
    })
  }

  const ambiguousRoots = new Set(deterministic.ambiguous.map((entry) => entry.root))
  const acceptedRoots = new Set(deterministic.accepted.map((entry) => entry.root))
  const rootsNeedingLlm = roots.filter((root) => {
    const hasAccepted = acceptedRoots.has(root)
    const hasAmbiguous = ambiguousRoots.has(root)
    return !hasAccepted || hasAmbiguous
  })

  const rootsResolvedDeterministically = roots.filter((root) => {
    return acceptedRoots.has(root) && !ambiguousRoots.has(root)
  }).length

  if (
    deterministic.scanErrors.length > 0 &&
    deterministic.accepted.length === 0 &&
    deterministic.ambiguous.length === 0
  ) {
    getLogger().warn(
      "identifyDatabases: deterministic scan failed before LLM fallback",
      {
        repositoryId,
        targetHash,
        scanErrors: deterministic.scanErrors,
      },
    )
  }

  const capturedDbs: { value: SubmittedDatabase[] } = { value: [] }
  if (rootsNeedingLlm.length > 0) {
    const ambiguousByRoot = deterministic.ambiguous
      .filter((entry) => rootsNeedingLlm.includes(entry.root))
      .map((entry) => {
        return `${entry.root}:${entry.dbType} (${entry.confidence.toFixed(2)} via ${entry.signalKinds.join("+")})`
      })
    const deterministicHint =
      ambiguousByRoot.length > 0
        ? `\nDeterministic ambiguous candidates:\n- ${ambiguousByRoot.join("\n- ")}\nUse these as hints and verify against repository evidence.`
        : ""

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

Use repositoryId "${repositoryId}" for all tool calls. Roots to explore: ${rootsNeedingLlm.join(", ")}.

${REPO_EXPLORER_TOOLS_HINT}${scopeHint}${deterministicHint}`,
    })

    const userMessage = `For these roots only: ${rootsNeedingLlm.join(", ")}. Check config directories and search for database/ORM patterns. Call submit_databases (batch per call) once connection or schema evidence is clear; skip uncertain hits.`

    await agent.invoke(
      { messages: [new HumanMessage(userMessage)] },
      mergeConfigs(getConfig(), {
        recursionLimit: 180,
      }),
    )

    if (capturedDbs.value.length === 0) {
      getLogger().warn(
        "identifyDatabases: agent completed without submit_databases (no databases captured)",
        { repositoryId, targetHash, rootsNeedingLlm },
      )
    }
  }

  let submissions = capturedDbs.value
  if (state.ingestMode === "partial" && scanPaths.length > 0) {
    submissions = submissions.filter((db) =>
      repoPathMatchesPartialScan(db.path, scanPaths),
    )
  }

  for (const db of submissions) {
    const root = resolveSubmissionRoot(db.path, rootsNeedingLlm)
    if (root === null) continue
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
      subjectRef: `svc:${repositoryId}:${root}`,
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

  getLogger().info("identifyDatabases: deterministic + llm summary", {
    repositoryId,
    targetHash,
    rootsTotal: roots.length,
    rootsResolvedDeterministically,
    rootsNeedingLlm: rootsNeedingLlm.length,
    deterministicAccepted: deterministic.accepted.length,
    ambiguousCount: deterministic.ambiguous.length,
  })

  return {
    extractedObjects: objects,
    extractedClaims: claims,
  }
}
