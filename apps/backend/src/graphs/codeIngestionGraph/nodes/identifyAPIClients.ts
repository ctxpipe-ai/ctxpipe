/**
 * identifyAPIClients extractor
 *
 * Detects API clients used by services in the codebase. Produces CONSUMES_API claims
 * (Service → API or Service → Operation). For internal APIs, emits stub API objects
 * (same api: dedup keys as identifyAPIs) so claims resolve; identifyAPIs enriches the
 * same keys when present. For external APIs, creates API objects with dedup key
 * api:${repositoryId}:${root}:external:${name}.
 *
 * Runs in parallel with identifyAPIs; external API objects are independent;
 * internal keys match identifyAPIs (same root/path); store merges stub with richer payloads.
 */

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
import {
  processApiClients,
  type SubmittedApiClient,
} from "./processApiClients.js"

const submittedApiClientSchema = z
  .object({
    path: z
      .string()
      .describe(
        "Directory or root where client code lives, e.g. apps/web, apps/backend",
      ),
    consumedApi: z
      .string()
      .optional()
      .describe("Path to internal API in repo, e.g. apps/web/src/app/api"),
    consumedApiName: z
      .string()
      .optional()
      .describe("External API name, e.g. Stripe, SendGrid, Twilio, Supabase"),
    consumedApiUrl: z
      .string()
      .optional()
      .describe("Env var or config key for URL, e.g. API_BASE_URL, STRIPE_KEY"),
    evidence: z
      .string()
      .optional()
      .describe("Brief evidence of how the client was detected"),
  })
  .refine(
    (v) =>
      (v.consumedApi != null && v.consumedApi.trim().length > 0) ||
      (v.consumedApiName != null && v.consumedApiName.trim().length > 0),
    { message: "Each API client must include consumedApi or consumedApiName" },
  )

function createIdentifyAPIClientsTools(capturedClients: {
  value: SubmittedApiClient[]
}) {
  const submitApiClientsTool = tool(
    async ({ apiClients }) => {
      capturedClients.value.push(...apiClients)
      return `Recorded ${apiClients.length} API client(s). Total: ${capturedClients.value.length}.`
    },
    {
      name: "submit_api_clients",
      description: `Call this when you have discovered one or more API clients used by the codebase. For each client provide path (directory or root where the client code lives, e.g. apps/web or apps/backend), and either consumedApi (path to internal API in repo, e.g. apps/web/src/app/api) OR consumedApiName (external API name, e.g. Stripe, SendGrid, Twilio), optionally consumedApiUrl (env var or config key, e.g. STRIPE_KEY, API_BASE_URL), and optional evidence.`,
      schema: z.object({
        apiClients: z.array(submittedApiClientSchema),
      }),
    },
  )
  return [...standardRepoExplorerTools, submitApiClientsTool]
}

const SYSTEM_PROMPT = `You are analyzing a repository to detect all API clients — code that consumes external or internal APIs. Look across any language — JavaScript, TypeScript, Python, Go, Java, Kotlin, Ruby, PHP, C#, Rust, and others. Do not assume a single stack.

Detection hints:

| Category        | Detection hints |
| ---------------- | ---------------- |
| HTTP clients    | axios, fetch, ky, got, httpx, requests (Python), http.Client (Go), RestTemplate (Java) |
| SDKs            | @stripe/stripe-js, twilio, sendgrid, @supabase/supabase-js (client), @slack/web-api |
| OpenAPI clients | openapi-fetch, @hey-api/openapi-ts, openapi-typescript-codegen |
| Config/env      | API_BASE_URL, STRIPE_KEY, SENDGRID_API_KEY, TWILIO_*, SUPABASE_URL, etc. |

Search strategy:
1. list_files at each root for package.json, requirements.txt, go.mod, etc.
2. search for HTTP client imports (axios, fetch, ky), SDK imports (@stripe, twilio, sendgrid), env vars (API_BASE_URL, *_API_KEY, *_URL)
3. get_file on package manifests, env examples, client initialization code

For internal APIs: use consumedApi with the path to the API directory in the repo (e.g. apps/web/src/app/api).
For external APIs: use consumedApiName (e.g. Stripe, SendGrid) and optionally consumedApiUrl (env var or config).

For each API client found, call submit_api_clients with path, consumedApi OR consumedApiName, and optional evidence. Be thorough. Explore all roots. Prefer submit_api_clients once manifest/SDK evidence is clear.`

export async function identifyAPIClients(
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

  const capturedClients: { value: SubmittedApiClient[] } = { value: [] }
  const tools = createIdentifyAPIClientsTools(capturedClients)
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

  const userMessage = `Explore the repository for API clients. List files in config directories, search for HTTP clients, SDKs, and API config patterns. For each client found, determine if it consumes an internal API (path in repo) or external API (name like Stripe, SendGrid). Call submit_api_clients for each.`

  await agent.invoke(
    { messages: [new HumanMessage(userMessage)] },
    {
      recursionLimit: 180,
    },
  )

  if (capturedClients.value.length === 0) {
    getLogger().warn(
      "identifyAPIClients: agent completed without submit_api_clients (no API clients captured)",
      { repositoryId, targetHash },
    )
  }

  let submissions = capturedClients.value
  if (state.ingestMode === "partial" && scanPaths.length > 0) {
    submissions = submissions.filter((c) =>
      repoPathMatchesPartialScan(c.path, scanPaths),
    )
  }

  const { objects: processedObjects, claims: processedClaims } =
    processApiClients(submissions, repositoryId, roots, targetHash)
  objects.push(...processedObjects)
  claims.push(...processedClaims)

  return {
    extractedObjects: objects,
    extractedClaims: claims,
  }
}
