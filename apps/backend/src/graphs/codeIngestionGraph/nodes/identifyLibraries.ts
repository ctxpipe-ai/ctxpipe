/**
 * identifyLibraries extractor
 *
 * Detects architectural libraries (ORM, HTTP client, auth, validation, etc.) used by
 * services in a repository. Uses an LLM agent with list_files, search, and get_file
 * tools to explore package manifests and source code, then produces Library objects
 * and USES_LIBRARY claims (Service → Library).
 *
 * Deduplication: lib:${repositoryId}:${root}:${libraryName}
 * Claim path: subjectRef = svc:${repositoryId}:${root}, objectRef = lib key
 */

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
  detectLibrariesDeterministic,
  normalizeLibraryName,
} from "./identifyLibrariesDeterministic.js"
import {
  partialScanPathsForExtractors,
  partialScanPromptSuffix,
  repoPathMatchesPartialScan,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"

type SubmittedLibrary = {
  name: string
  path: string
  category?: string
  evidence?: string
  extractionMethod?: "deterministic" | "llm"
  confidence?: number
  provenance?: Record<string, unknown>
}

function createIdentifyLibrariesTools(capturedLibraries: {
  value: SubmittedLibrary[]
}) {
  const submitLibrariesTool = tool(
    async ({ libraries }) => {
      capturedLibraries.value.push(...libraries)
      return `Recorded ${libraries.length} library(ies). Total: ${capturedLibraries.value.length}.`
    },
    {
      name: "submit_libraries",
      description: `Call this when you have discovered one or more architectural libraries used by the codebase. For each library provide name (e.g. Prisma, Drizzle, Express, Hono, Zod, Better Auth, ioredis), path (root or directory where it's used, e.g. apps/web or .), optional category (ORM, HTTP, auth, validation, cache, etc.), and optional evidence (brief description of how you found it). Focus on architectural deps — ORM, HTTP client, auth, validation — not every util.`,
      schema: z.object({
        libraries: z.array(
          z.object({
            name: z
              .string()
              .describe(
                "Library name: Prisma, Drizzle, Express, Hono, Zod, Better Auth, ioredis, etc.",
              ),
            path: z
              .string()
              .describe(
                "Root or directory path where library is used, e.g. apps/web or .",
              ),
            category: z
              .string()
              .optional()
              .describe("Category: ORM, HTTP, auth, validation, cache, etc."),
            evidence: z
              .string()
              .optional()
              .describe("Brief evidence, e.g. from package.json dependencies"),
          }),
        ),
      }),
    },
  )
  return [...standardRepoExplorerTools, submitLibrariesTool]
}

const SYSTEM_PROMPT = `You are analyzing a repository to detect architectural libraries used by the codebase. Focus on ORM, HTTP client, auth, validation, cache, and similar — not every utility. Look across any language. Do not assume a single stack.

Config files to inspect (per language):
| Language / ecosystem | Config files |
| JS/TS (Node, Bun)    | package.json, pnpm-lock.yaml, yarn.lock |
| Python               | requirements.txt, pyproject.toml, Pipfile |
| Go                   | go.mod, go.sum |
| Java / Kotlin        | pom.xml, build.gradle, build.gradle.kts |
| Ruby                 | Gemfile |
| PHP                  | composer.json |
| C# / .NET            | *.csproj |
| Rust                 | Cargo.toml |
| Elixir               | mix.exs |
| Swift                | Package.swift |

Library categories and detection hints:
| Category   | Examples | Detection hints |
| ORM        | Prisma, Drizzle, TypeORM, Sequelize, Mongoose, SQLAlchemy, GORM | prisma, drizzle, typeorm, sequelize, mongoose, sqlalchemy, gorm |
| HTTP       | Express, Hono, Fastify, Next.js, FastAPI, Flask, Django, Axum | express, hono, fastify, next, fastapi, flask, django, axum |
| Auth       | Better Auth, NextAuth, Passport, Auth0, Clerk | better-auth, next-auth, passport, auth0, clerk |
| Validation | Zod, Yup, Joi, Pydantic | zod, yup, joi, pydantic |
| Cache      | ioredis, @upstash/redis, redis-py, go-redis | ioredis, upstash, redis |
| RPC/API    | tRPC, gRPC | trpc, grpc |

Search strategy:
1. list_files at each root for package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml, pom.xml, Gemfile, composer.json, mix.exs
2. search for import patterns (from "prisma", import { drizzle }, require("express"), betterAuth, zod, ioredis)
3. get_file on package.json, requirements.txt, etc. to confirm dependencies
4. Focus on architectural deps — skip lodash, date-fns, uuid, etc. unless central to architecture

Cover only the listed roots. Call submit_libraries for each architectural library supported by manifests or imports; batch multiple libraries per call. Focus on architectural deps — skip utilities unless central. Prefer submitting once you have enough manifest/import evidence over exhaustive blind search.`

export async function identifyLibraries(
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

  const deterministic = await detectLibrariesDeterministic({
    repositoryId,
    orgId,
    roots,
    scanPaths: state.ingestMode === "partial" ? scanPaths : undefined,
  })

  if (
    deterministic.manifestFilesChecked > 0 &&
    deterministic.manifestParseFailures === deterministic.manifestFilesChecked
  ) {
    getLogger().warn(
      "identifyLibraries: deterministic parsing failed for all manifests; falling back to LLM roots",
      {
        repositoryId,
        targetHash,
        roots,
        manifestFilesChecked: deterministic.manifestFilesChecked,
        manifestParseFailures: deterministic.manifestParseFailures,
      },
    )
  }

  const deterministicSubmissions: SubmittedLibrary[] = deterministic.accepted.map(
    (candidate) => ({
      name: candidate.name,
      path: candidate.root,
      category: candidate.category,
      evidence: candidate.evidence.join("; "),
      extractionMethod: "deterministic",
      confidence: candidate.confidence,
      provenance: {
        detectionSignals: candidate.detectionSignals,
        manifestPath: candidate.manifestPath,
        importPath: candidate.importPath,
        categorySource: candidate.categorySource,
        scoreBreakdown: candidate.scoreBreakdown,
      },
    }),
  )
  const rootsNeedingLlm = deterministic.rootsNeedingLlm
  const capturedLibraries: { value: SubmittedLibrary[] } = { value: [] }
  if (rootsNeedingLlm.length > 0) {
    const tools = createIdentifyLibrariesTools(capturedLibraries)
    const agent = createAgent({
      model: getModel("medium", { temperature: 0.1 }),
      tools,
      contextMiddleware: {
        clearToolUsesTriggerTokens: 160_000,
        clearToolUsesKeepMessages: 16,
        summarizationTriggerTokens: 240_000,
        summarizationKeepMessages: 36,
      },
      systemPrompt: `${SYSTEM_PROMPT}

Use repositoryId "${repositoryId}" for all tool calls. Roots to explore: ${rootsNeedingLlm.join(", ")}.

${REPO_EXPLORER_TOOLS_HINT}${scopeHint}`,
    })

    const userMessage = `For these roots only: ${rootsNeedingLlm.join(", ")}. Check package manifests and search for architectural library imports (ORM, HTTP, auth, validation, cache). Call submit_libraries (batch per call) once manifest/import evidence is clear; skip utilities and uncertain hits.`

    await agent.invoke(
      { messages: [new HumanMessage(userMessage)] },
      mergeConfigs(getConfig(), {
        recursionLimit: 220,
      }),
    )

    if (capturedLibraries.value.length === 0) {
      getLogger().warn(
        "identifyLibraries: agent completed without submit_libraries for fallback roots",
        { repositoryId, targetHash, rootsNeedingLlm },
      )
    }
  }

  let llmSubmissions = capturedLibraries.value.map((submission) => ({
    ...submission,
    extractionMethod: "llm" as const,
    confidence: submission.confidence ?? 0.8,
  }))
  if (rootsNeedingLlm.length > 0) {
    llmSubmissions = llmSubmissions.filter((lib) =>
      rootsNeedingLlm.some((root) =>
        root === "./"
          ? true
          : lib.path === root || lib.path.startsWith(`${root}/`),
      ),
    )
  }
  if (state.ingestMode === "partial" && scanPaths.length > 0) {
    llmSubmissions = llmSubmissions.filter((lib) =>
      repoPathMatchesPartialScan(lib.path, scanPaths),
    )
  }
  const submissions = [...deterministicSubmissions, ...llmSubmissions]

  getLogger().info("identifyLibraries: deterministic + fallback summary", {
    repositoryId,
    targetHash,
    rootsTotal: roots.length,
    deterministicRootsResolved: deterministic.rootsResolvedDeterministically.length,
    rootsRequiringLlm: rootsNeedingLlm.length,
    deterministicAccepted: deterministic.accepted.length,
    deterministicAmbiguous: deterministic.ambiguous.length,
  })

  const { objects: postObjects, claims: postClaims } = postProcessLibraries(
    submissions,
    { repositoryId, roots, targetHash },
  )

  return {
    extractedObjects: postObjects,
    extractedClaims: postClaims,
  }
}

/** Post-process captured libraries into objects and claims. Exported for testing. */
export function postProcessLibraries(
  capturedLibraries: SubmittedLibrary[],
  state: Pick<CodeIngestionState, "repositoryId" | "roots" | "targetHash">,
): { objects: ExtractedObject[]; claims: ExtractedClaim[] } {
  const { repositoryId, roots = ["./"], targetHash } = state
  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []
  const seenLibs = new Set<string>()
  const orderedLibraries = [...capturedLibraries].sort((left, right) => {
    const leftRank = left.extractionMethod === "deterministic" ? 0 : 1
    const rightRank = right.extractionMethod === "deterministic" ? 0 : 1
    return leftRank - rightRank
  })

  for (const lib of orderedLibraries) {
    const root = resolveSubmissionRoot(lib.path, roots)
    if (root === null) continue
    const libraryName = normalizeLibraryName(lib.name)
    const dedupKey = `lib:${repositoryId}:${root}:${libraryName}`
    if (seenLibs.has(dedupKey)) continue
    seenLibs.add(dedupKey)

    const svcDeduplicationKey = `svc:${repositoryId}:${root}`

    objects.push({
      kind: "Library",
      deduplicationKey: dedupKey,
      name: libraryName,
      summary: `${libraryName} used by ${root}${lib.category ? ` (${lib.category})` : ""}`,
      payload: lib.category ? { category: lib.category } : undefined,
    })

    claims.push({
      subjectRef: svcDeduplicationKey,
      subjectKind: "Service",
      objectRef: dedupKey,
      objectKind: "Library",
      predicate: "USES_LIBRARY",
      sourceId: `identifyLibraries:${repositoryId}:${root}:${libraryName}:${targetHash}`,
      sourceType: "git",
      extractionMethod: lib.extractionMethod ?? "llm",
      confidence: lib.confidence ?? 0.8,
      provenance: {
        ...(lib.provenance ?? {}),
        root,
        libraryName,
        category: lib.category,
        evidence: lib.evidence,
      },
    })
  }

  return { objects, claims }
}
