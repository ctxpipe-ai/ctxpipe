/**
 * identifyInfrastructure – Extracts Infrastructure objects and RUNS_ON claims
 * (Service → Infrastructure) from repository code. Uses an LLM agent with
 * list_files, search, get_file, and submit_infrastructure tools to detect
 * deployment targets (Docker, Kubernetes, Serverless, Terraform, etc.).
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
import type { CodeIngestionState } from "../schemas.js"
import {
  processCapturedInfrastructure,
  type SubmittedInfrastructure,
} from "./identifyInfrastructurePostProcess.js"

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

For each infrastructure found, call submit_infrastructure with infraType, path (root or directory), and optional evidence. Be thorough. Explore all roots. Terraform/Pulumi: focus on compute-related resources; lighter scan is acceptable.`

export async function identifyInfrastructure(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, roots = ["./"], targetHash } = state
  requireCurrentOrgId()

  const capturedInfra: { value: SubmittedInfrastructure[] } = { value: [] }
  const tools = createIdentifyInfrastructureTools(capturedInfra)
  const agent = createAgent({
    model: getModel("medium", { temperature: 0.1 }),
    tools,
    systemPrompt: `${SYSTEM_PROMPT}

Use repositoryId "${repositoryId}" for all tool calls. Roots to explore: ${roots.join(", ")}.

${REPO_EXPLORER_TOOLS_HINT}`,
  })

  const userMessage = `Explore the repository for infrastructure and deployment targets. List files at roots, search for Dockerfile, docker-compose, Kubernetes manifests, serverless config, Terraform/Pulumi. For each infrastructure found, read the relevant config to confirm, then call submit_infrastructure.`

  const stream = await agent.stream(
    { messages: [new HumanMessage(userMessage)] },
    {
      streamMode: "values",
      callbacks: langfusePipelineCallbacks({
        step: "codeIngestion.identifyInfrastructure",
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

  const result = processCapturedInfrastructure(
    capturedInfra.value,
    repositoryId,
    roots,
    targetHash,
  )
  return {
    extractedObjects: result.extractedObjects,
    extractedClaims: result.extractedClaims,
  }
}
