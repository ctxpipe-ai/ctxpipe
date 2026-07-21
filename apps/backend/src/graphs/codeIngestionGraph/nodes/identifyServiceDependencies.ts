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
import { mergeConfigs } from "@langchain/core/runnables"
import { getConfig } from "@langchain/langgraph"
import { tool } from "langchain"
import { z } from "zod/v3"
import { requireCurrentOrgId } from "../../../auth/context.js"
import { getLogger } from "../../../observability/logger.js"
import { getIngestionModel } from "../../../retrieval/services/modelProvider.js"
import {
  REPO_EXPLORER_TOOLS_HINT,
  standardRepoExplorerTools,
} from "../../../tools/repoExplorerTools.js"
import { createAgent } from "../../createAgent.js"
import type { CodeIngestionState, ExtractedClaim } from "../schemas.js"
import { resolveSubmissionRoot } from "./extractionSubmissionRoot.js"
import {
  partialScanPathsForExtractors,
  partialScanPromptSuffix,
  repoPathMatchesPartialScan,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"

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

Cover only the listed roots. Call submit_service_dependencies for each in-repo dependency supported by workspace config or imports; batch multiple dependencies per call. Only report dependencies within this repository — not external npm packages. Prefer submitting once workspace/import evidence is clear over exhaustive blind search.`

export async function identifyServiceDependencies(
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

  const capturedDeps: { value: SubmittedDependency[] } = { value: [] }
  const tools = createIdentifyServiceDependenciesTools(capturedDeps)
  const agent = createAgent({
    model: getIngestionModel("medium", { temperature: 0.1 }),
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

  const userMessage = `For the listed roots, check workspace configs and search for workspace refs, internal HTTP calls, and imports from in-repo packages. Call submit_service_dependencies (batch per call) once evidence is clear; skip external npm packages and uncertain hits.`

  await agent.invoke(
    { messages: [new HumanMessage(userMessage)] },
    mergeConfigs(getConfig(), {
      recursionLimit: 180,
    }),
  )

  if (capturedDeps.value.length === 0) {
    getLogger().warn(
      "identifyServiceDependencies: agent completed without submit_service_dependencies (no dependencies captured)",
      { repositoryId, targetHash },
    )
  }

  let submissions = capturedDeps.value
  if (state.ingestMode === "partial" && scanPaths.length > 0) {
    submissions = submissions.filter(
      (dep) =>
        repoPathMatchesPartialScan(dep.consumerPath, scanPaths) ||
        repoPathMatchesPartialScan(dep.providerPath, scanPaths),
    )
  }

  const claims = postProcessServiceDependencies(submissions, {
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
