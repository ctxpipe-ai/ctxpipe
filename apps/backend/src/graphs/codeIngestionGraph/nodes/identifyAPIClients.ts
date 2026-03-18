/**
 * identifyAPIClients extractor
 *
 * Detects API clients used by services in the codebase. Produces CONSUMES_API claims
 * (Service → API or Service → Operation). For internal APIs, references existing api:
 * keys from identifyAPIs. For external APIs, creates API objects with dedup key
 * api:${repositoryId}:${root}:external:${name}.
 *
 * Runs in parallel with identifyAPIs; external API objects are independent;
 * internal refs match api: keys from identifyAPIs (same root/path).
 */

import { HumanMessage } from "@langchain/core/messages"
import { tool } from "langchain"
import { z } from "zod/v3"
import { createAgent } from "langchain"
import { requireCurrentOrgId } from "../../../auth/context.js"
import { getLangfuseHandler } from "../../../observability/langfuse.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import { getFileTool } from "../../../tools/getFile.js"
import { listFilesTool } from "../../../tools/listFiles.js"
import { searchTool } from "../../../tools/search.js"
import type { CodeIngestionState, ExtractedClaim, ExtractedObject } from "../schemas.js"
import {
  processApiClients,
  type SubmittedApiClient,
} from "./processApiClients.js"

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
        apiClients: z.array(
          z.object({
            path: z.string().describe("Directory or root where client code lives, e.g. apps/web, apps/backend"),
            consumedApi: z.string().optional().describe("Path to internal API in repo, e.g. apps/web/src/app/api"),
            consumedApiName: z.string().optional().describe("External API name, e.g. Stripe, SendGrid, Twilio, Supabase"),
            consumedApiUrl: z.string().optional().describe("Env var or config key for URL, e.g. API_BASE_URL, STRIPE_KEY"),
            evidence: z.string().optional().describe("Brief evidence of how the client was detected"),
          }),
        ),
      }),
    },
  )
  return [listFilesTool, searchTool, getFileTool, submitApiClientsTool]
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

For each API client found, call submit_api_clients with path, consumedApi OR consumedApiName, and optional evidence. Be thorough. Explore all roots.`

export async function identifyAPIClients(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, roots = ["./"], targetHash } = state
  requireCurrentOrgId()
  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []

  const capturedClients: { value: SubmittedApiClient[] } = { value: [] }
  const tools = createIdentifyAPIClientsTools(capturedClients)
  const agent = createAgent({
    model: getModel("medium", { temperature: 0.1 }),
    tools,
    systemPrompt: `${SYSTEM_PROMPT}

Use repositoryId "${repositoryId}" for all tool calls. Roots to explore: ${roots.join(", ")}.`,
  })

  const userMessage = `Explore the repository for API clients. List files in config directories, search for HTTP clients, SDKs, and API config patterns. For each client found, determine if it consumes an internal API (path in repo) or external API (name like Stripe, SendGrid). Call submit_api_clients for each.`

  const stream = await agent.stream(
    { messages: [new HumanMessage(userMessage)] },
    { streamMode: "values", callbacks: [getLangfuseHandler()] },
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

  const { objects: processedObjects, claims: processedClaims } = processApiClients(
    capturedClients.value,
    repositoryId,
    roots,
    targetHash,
  )
  objects.push(...processedObjects)
  claims.push(...processedClaims)

  return {
    extractedObjects: objects,
    extractedClaims: claims,
  }
}
