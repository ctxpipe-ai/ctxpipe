/**
 * identifyInfrastructure – Extracts Infrastructure objects and RUNS_ON claims
 * (Service → Infrastructure) from repository code. Uses an LLM agent with
 * list_files, search, get_file, and submit_infrastructure tools to detect
 * deployment targets (Docker, Kubernetes, Serverless, Terraform, etc.).
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
import type { CodeIngestionState } from "../schemas.js"
import {
  processCapturedInfrastructure,
  type SubmittedInfrastructure,
} from "./identifyInfrastructurePostProcess.js"
import {
  partialScanPathsForExtractors,
  partialScanPromptSuffix,
  repoPathMatchesPartialScan,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"

function createIdentifyInfrastructureTools(capturedInfra: {
  value: SubmittedInfrastructure[]
}) {
  const submitInfrastructureTool = tool(
    async ({ infrastructure }) => {
      capturedInfra.value.push(...infrastructure)
      return `Recorded ${infrastructure.length} infrastructure item(s). Total: ${capturedInfra.value.length}.`
    },
    {
      name: "submit_infrastructure",
      description: `Call this when you have discovered one or more infrastructure/deployment targets used by the codebase. For each provide infraType (e.g. Docker, Docker Compose, Kubernetes, Helm, Serverless, Lambda, Cloud Run, Terraform, Pulumi), path (root or directory where it's defined/used), and optional evidence (brief description of how you found it).`,
      schema: z.object({
        infrastructure: z.array(
          z.object({
            infraType: z
              .string()
              .describe(
                "Infrastructure type: Docker, Docker Compose, Kubernetes, Helm, Serverless, Lambda, Cloud Run, Terraform, Pulumi, Cloudflare Workers, Vercel, Fly.io, etc.",
              ),
            path: z
              .string()
              .describe(
                "Root or directory path where infrastructure is defined or used, e.g. apps/web or .",
              ),
            evidence: z
              .string()
              .optional()
              .describe("Brief evidence, e.g. Dockerfile found at apps/api"),
          }),
        ),
      }),
    },
  )
  return [...standardRepoExplorerTools, submitInfrastructureTool]
}

const SYSTEM_PROMPT = `You are analyzing a repository to detect all infrastructure and deployment targets used by the codebase. Look across any language and platform. Do not assume a single stack.

Config files and detection hints:

| Infrastructure      | Detection hints |
| ------------------- | --------------- |
| Docker              | Dockerfile, .dockerignore |
| Docker Compose      | docker-compose.yml, docker-compose.yaml, docker-compose.*.yml |
| Kubernetes         | k8s/, manifests/, *.yaml with apiVersion: apps/v1, batch/v1, networking.k8s.io/v1; Deployment, Service, ConfigMap, Ingress |
| Helm                | Chart.yaml, values.yaml, helm/ directory |
| Serverless          | serverless.yml, serverless.yaml |
| Lambda              | sam.yaml, template.yaml (SAM), serverless.yml with provider.aws, lambda config |
| Cloud Run           | cloudbuild.yaml with gcr.io/run, Dockerfile + Cloud Run config, run.yaml |
| Terraform           | *.tf files referencing compute (aws_instance, google_compute_instance, azurerm_virtual_machine) |
| Pulumi              | Pulumi.yaml, *.ts/*.py with pulumi, aws.ec2, gcp.compute |
| Cloudflare Workers  | wrangler.toml, workers config |
| Vercel              | vercel.json, .vercel/ |
| Fly.io              | fly.toml |
| Railway             | railway.json, railway.toml |
| Render              | render.yaml |

Search strategy:
1. list_files at each root for Dockerfile, docker-compose*.yml, k8s/, manifests/, Chart.yaml, serverless.yml, sam.yaml, *.tf, Pulumi.yaml, wrangler.toml, vercel.json, fly.toml
2. search for apiVersion: apps/v1, kind: Deployment, FROM in Dockerfile, serverless framework, terraform, pulumi
3. get_file on Dockerfile, docker-compose.yml, k8s manifests, serverless.yml to confirm

Cover only the listed roots. Call submit_infrastructure for each deployment target supported by Dockerfiles, manifests, or IaC; batch multiple items per call. Terraform/Pulumi: focus on compute-related resources; lighter scan is acceptable. Prefer submitting once Dockerfile/manifest evidence is clear over exhaustive blind search.`

export async function identifyInfrastructure(
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

  const capturedInfra: { value: SubmittedInfrastructure[] } = { value: [] }
  const tools = createIdentifyInfrastructureTools(capturedInfra)
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

  const userMessage = `For the listed roots, check for Dockerfile, docker-compose, k8s manifests, serverless config, and Terraform/Pulumi. Call submit_infrastructure (batch per call) once manifest evidence is clear; skip uncertain hits.`

  await agent.invoke(
    { messages: [new HumanMessage(userMessage)] },
    mergeConfigs(getConfig(), {
      recursionLimit: 180,
    }),
  )

  if (capturedInfra.value.length === 0) {
    getLogger().warn(
      "identifyInfrastructure: agent completed without submit_infrastructure (no infrastructure captured)",
      { repositoryId, targetHash },
    )
  }

  let submissions = capturedInfra.value
  if (state.ingestMode === "partial" && scanPaths.length > 0) {
    submissions = submissions.filter((inf) =>
      repoPathMatchesPartialScan(inf.path, scanPaths),
    )
  }

  const result = processCapturedInfrastructure(
    submissions,
    repositoryId,
    roots,
    targetHash,
  )
  return {
    extractedObjects: result.extractedObjects,
    extractedClaims: result.extractedClaims,
  }
}
