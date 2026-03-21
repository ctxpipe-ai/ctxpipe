/**
 * identifyServiceDependencies extractor
 *
 * Detects cross-service dependencies within a monorepo. Uses an LLM agent with
 * list_files, search, and get_file tools to explore package manifests, workspace
 * configs, and source code. Produces DEPENDS_ON claims (Service → Service) only —
 * no new objects. Service nodes are created by extractKind.
 *
 * Detection hints:
 * - Internal package refs: "@repo/api": "workspace:*", from "@repo/shared"
 * - HTTP calls to internal URLs: localhost, internal hostnames, service discovery
 * - pnpm/npm/yarn workspace references in package.json, pnpm-workspace.yaml
 *
 * Claim path: subjectRef = svc:${repositoryId}:${consumerRoot},
 * objectRef = svc:${repositoryId}:${providerRoot}, predicate = DEPENDS_ON
 */

import { HumanMessage } from "@langchain/core/messages"
import { tool } from "langchain"
import { z } from "zod/v3"
import { requireCurrentOrgId } from "../../../auth/context.js"
import { langfusePipelineCallbacks } from "../../../observability/langfusePipelineMetrics.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import {
  REPO_EXPLORER_TOOLS_HINT,
  standardRepoExplorerTools,
} from "../../../tools/repoExplorerTools.js"
import { createAgent } from "../../createAgent.js"
import type { CodeIngestionState, ExtractedClaim } from "../schemas.js"
import { resolveSubmissionRoot } from "./extractionSubmissionRoot.js"

type SubmittedDependency = {
  consumerPath: string
  providerPath: string
  evidence?: string
}

function createIdentifyServiceDependenciesTools(capturedDeps: {
  value: SubmittedDependency[]
}) {
  const submitServiceDependenciesTool = tool(
    async ({ dependencies }) => {
      capturedDeps.value.push(...dependencies)
      return `Recorded ${dependencies.length} dependency(ies). Total: ${capturedDeps.value.length}.`
    },
    {
      name: "submit_service_dependencies",
      description: `Call this when you have discovered one or more cross-service dependencies within the monorepo. For each dependency provide consumerPath (root of the service that depends, e.g. apps/web), providerPath (root of the service being depended on, e.g. apps/api or packages/shared), and optional evidence (brief description of how you found it).`,
      schema: z.object({
        dependencies: z.array(
          z.object({
            consumerPath: z
              .string()
              .describe("Root of the service that depends, e.g. apps/web"),
            providerPath: z
              .string()
              .describe(
                "Root of the service being depended on, e.g. apps/api or packages/shared",
              ),
            evidence: z
              .string()
              .optional()
              .describe(
                "Brief evidence, e.g. package.json workspace dependency",
              ),
          }),
        ),
      }),
    },
  )
  return [...standardRepoExplorerTools, submitServiceDependenciesTool]
}

const SYSTEM_PROMPT = `You are analyzing a monorepo to detect cross-service dependencies. Find which services/apps depend on which other services or shared packages within the same repository.

Detection hints:
| Signal | Examples |
|--------|----------|
| Internal package refs | "@repo/api": "workspace:*", "@repo/shared": "workspace:^", from "@repo/shared" |
| Workspace config | pnpm-workspace.yaml, package.json "workspaces", yarn workspaces, lerna packages |
| HTTP calls to internal URLs | localhost:3001, http://api.internal, service discovery, env vars like API_URL |
| Import paths | from "@repo/shared", import from "../packages/utils" |

Files to inspect:
- package.json (dependencies, devDependencies with workspace:* or workspace:^)
- pnpm-workspace.yaml, pnpm-workspace.yml
- package.json "workspaces" field (npm/yarn)
- lerna.json, nx.json
- .env.example, config files with service URLs
- Source code: fetch(API_URL), axios.get(internalUrl), import from workspace packages

For each dependency found, call submit_service_dependencies with consumerPath (root of consumer, e.g. apps/web), providerPath (root of provider, e.g. apps/api or packages/shared), and optional evidence. Only report dependencies within this repository — not external npm packages. Be thorough. Explore all roots.`

export async function identifyServiceDependencies(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, roots = ["./"], targetHash } = state
  requireCurrentOrgId()

  const capturedDeps: { value: SubmittedDependency[] } = { value: [] }
  const tools = createIdentifyServiceDependenciesTools(capturedDeps)
  const agent = createAgent({
    model: getModel("medium", { temperature: 0.1 }),
    tools,
    systemPrompt: `${SYSTEM_PROMPT}

Use repositoryId "${repositoryId}" for all tool calls. Roots to explore: ${roots.join(", ")}.

${REPO_EXPLORER_TOOLS_HINT}`,
  })

  const userMessage = `Explore the repository for cross-service dependencies. List package manifests, workspace configs, search for workspace:* refs, internal HTTP calls, and imports from workspace packages. For each dependency found, call submit_service_dependencies with consumerPath, providerPath, and optional evidence.`

  const stream = await agent.stream(
    { messages: [new HumanMessage(userMessage)] },
    {
      streamMode: "values",
      callbacks: langfusePipelineCallbacks({
        step: "codeIngestion.identifyServiceDependencies",
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

  const claims = postProcessServiceDependencies(capturedDeps.value, {
    repositoryId,
    roots,
    targetHash,
  })

  return {
    extractedObjects: [],
    extractedClaims: claims,
  }
}

/** Post-process captured dependencies into DEPENDS_ON claims. Exported for testing. */
export function postProcessServiceDependencies(
  capturedDeps: SubmittedDependency[],
  state: Pick<CodeIngestionState, "repositoryId" | "roots" | "targetHash">,
): ExtractedClaim[] {
  const { repositoryId, roots = ["./"], targetHash } = state
  const claims: ExtractedClaim[] = []
  const seenPairs = new Set<string>()

  const rootSet = new Set(roots)

  for (const dep of capturedDeps) {
    const consumerRoot = resolveSubmissionRoot(dep.consumerPath, roots)
    const providerRoot = resolveSubmissionRoot(dep.providerPath, roots)

    if (!consumerRoot || !providerRoot) continue
    if (!rootSet.has(consumerRoot) || !rootSet.has(providerRoot)) continue
    if (consumerRoot === providerRoot) continue

    const dedupKey = `${consumerRoot}->${providerRoot}`
    if (seenPairs.has(dedupKey)) continue
    seenPairs.add(dedupKey)

    const subjectRef = `svc:${repositoryId}:${consumerRoot}`
    const objectRef = `svc:${repositoryId}:${providerRoot}`

    claims.push({
      subjectRef,
      subjectKind: "Service",
      objectRef,
      objectKind: "Service",
      predicate: "DEPENDS_ON",
      sourceId: `identifyServiceDependencies:${repositoryId}:${consumerRoot}:${providerRoot}:${targetHash}`,
      sourceType: "git",
      extractionMethod: "llm",
      confidence: 0.8,
      provenance: {
        consumerPath: dep.consumerPath,
        providerPath: dep.providerPath,
        evidence: dep.evidence,
      },
    })
  }

  return claims
}
