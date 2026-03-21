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
import { tool } from "langchain"
import { z } from "zod/v3"
import { requireCurrentOrgId } from "../../../auth/context.js"
import { langfusePipelineCallbacks } from "../../../observability/langfusePipelineMetrics.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import { getFileTool } from "../../../tools/getFile.js"
import { listFilesTool } from "../../../tools/listFiles.js"
import { searchTool } from "../../../tools/search.js"
import { createAgent } from "../../createAgent.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"
import { resolveSubmissionRoot } from "./extractionSubmissionRoot.js"

/** Normalize library name to canonical form for deduplication */
function normalizeLibraryName(name: string): string {
  const lower = name.toLowerCase()
  const known: Record<string, string> = {
    prisma: "Prisma",
    drizzle: "Drizzle",
    "drizzle-orm": "Drizzle",
    express: "Express",
    hono: "Hono",
    zod: "Zod",
    "better-auth": "Better Auth",
    ioredis: "ioredis",
    "next.js": "Next.js",
    next: "Next.js",
    fastify: "Fastify",
    "fast-api": "FastAPI",
    fastapi: "FastAPI",
    flask: "Flask",
    django: "Django",
    trpc: "tRPC",
    "@trpc/server": "tRPC",
    axios: "Axios",
    fetch: "fetch",
    "react-query": "TanStack Query",
    "tanstack-query": "TanStack Query",
    "@tanstack/react-query": "TanStack Query",
    mongoose: "Mongoose",
    typeorm: "TypeORM",
    knex: "Knex",
    sequelize: "Sequelize",
    "better-sqlite3": "better-sqlite3",
    redis: "Redis",
    "@upstash/redis": "Upstash Redis",
    supabase: "Supabase",
    "@supabase/supabase-js": "Supabase",
  }
  return known[lower] ?? name
}

type SubmittedLibrary = {
  name: string
  path: string
  category?: string
  evidence?: string
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
  return [listFilesTool, searchTool, getFileTool, submitLibrariesTool]
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

For each library found, call submit_libraries with name, path (root or directory), optional category, and optional evidence. Be thorough. Explore all roots.`

export async function identifyLibraries(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, roots = ["./"], targetHash } = state
  requireCurrentOrgId()

  const capturedLibraries: { value: SubmittedLibrary[] } = { value: [] }
  const tools = createIdentifyLibrariesTools(capturedLibraries)
  const agent = createAgent({
    model: getModel("medium", { temperature: 0.1 }),
    tools,
    systemPrompt: `${SYSTEM_PROMPT}

Use repositoryId "${repositoryId}" for all tool calls. Roots to explore: ${roots.join(", ")}.`,
  })

  const userMessage = `Explore the repository for architectural libraries (ORM, HTTP, auth, validation, cache). List package manifests, search for import patterns across all languages. For each library found, read the relevant config to confirm, then call submit_libraries.`

  const stream = await agent.stream(
    { messages: [new HumanMessage(userMessage)] },
    {
      streamMode: "values",
      callbacks: langfusePipelineCallbacks({
        step: "codeIngestion.identifyLibraries",
        dimensions: { repositoryId, targetHash },
      }),
    },
  )

  for await (const chunk of stream) {
    if (
      typeof chunk === "object" &&
      chunk !== null &&
      "messages" in chunk &&
      Array.isArray((chunk as { messages: unknown[] }).messages)
    ) {
      // Agent running
    }
  }

  const { objects: postObjects, claims: postClaims } = postProcessLibraries(
    capturedLibraries.value,
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

  for (const lib of capturedLibraries) {
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
      extractionMethod: "llm",
      confidence: 0.8,
      provenance: {
        root,
        libraryName,
        category: lib.category,
        evidence: lib.evidence,
      },
    })
  }

  return { objects, claims }
}
