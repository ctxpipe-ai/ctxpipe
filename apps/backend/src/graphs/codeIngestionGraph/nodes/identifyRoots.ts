import { HumanMessage } from "@langchain/core/messages"
import { tool } from "langchain"
import { z } from "zod/v3"
import { langfusePipelineCallbacks } from "../../../observability/langfusePipelineMetrics.js"
import { getLogger } from "../../../observability/logger.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import {
  REPO_EXPLORER_TOOLS_HINT,
  standardRepoExplorerTools,
} from "../../../tools/repoExplorerTools.js"
import { createAgent } from "../../createAgent.js"
import type { CodeIngestionState } from "../schemas.js"

const ROOTS_TOOL_NAME = "submit_roots"

function createIdentifyRootsTools(capturedRoots: { value: string[] | null }) {
  const submitRootsTool = tool(
    async ({ roots }) => {
      capturedRoots.value = roots
      return "Roots recorded successfully."
    },
    {
      name: ROOTS_TOOL_NAME,
      description:
        'Call this when you have determined the roots. For single-repo use ["./"]. For monorepo use relative paths to each package/app (e.g. ["apps/backend", "apps/ui"]).',
      schema: z.object({
        roots: z.array(z.string()).describe("Array of root paths"),
      }),
    },
  )
  return [...standardRepoExplorerTools, submitRootsTool]
}

export async function identifyRoots(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, targetHash } = state
  const capturedRoots: { value: string[] | null } = { value: null }

  const tools = createIdentifyRootsTools(capturedRoots)
  const agent = createAgent({
    model: getModel("fast", { temperature: 0.1 }),
    tools,
    systemPrompt: `You are analyzing a repository to detect its structure. Use repositoryId "${repositoryId}" for all tool calls.

Task: Determine if this is a single-repo or monorepo.
- Single-repo: one root at repo root → use ["./"]
- Monorepo: multiple workspace packages (pnpm, npm, lerna, Cargo, Go modules, Maven, Gradle, etc.) → list relative paths to each package/app

Use list_files to see root structure, search and get_file to read config files (package.json, pnpm-workspace.yaml, Cargo.toml, go.mod, pyproject.toml, etc.).
When you have enough evidence, call submit_roots — prefer a confident answer over exhaustive exploration.

${REPO_EXPLORER_TOOLS_HINT}`,
    // Ingestion: clear/summarize earlier than conversation defaults so tool transcripts do not dominate context.
    contextMiddleware: {
      clearToolUsesTriggerTokens: 120_000,
      clearToolUsesKeepMessages: 14,
      summarizationTriggerTokens: 200_000,
      summarizationKeepMessages: 32,
    },
  })

  const userMessage = `List files at the repository root, then determine the roots. Call submit_roots with your answer.`

  await agent.invoke(
    { messages: [new HumanMessage(userMessage)] },
    {
      // Explicit cap: do not inherit the parent LangGraph invoke recursionLimit (e.g. 1000) for this inner agent graph.
      recursionLimit: 100,
      callbacks: langfusePipelineCallbacks({
        step: "codeIngestion.identifyRoots",
        dimensions: { repositoryId, targetHash },
      }),
    },
  )

  const roots = capturedRoots.value
  const logger = getLogger()
  if (roots === null) {
    logger.warn(
      'identifyRoots: agent finished without submit_roots; defaulting to ["./"]',
      { repositoryId, targetHash },
    )
  }
  if (!roots || roots.length === 0) {
    logger.set({
      step: "codeIngestion.identifyRoots.summary",
      repositoryId,
      targetHash,
      rootsCount: 1,
      roots: ["./"],
      defaultedToRepoRoot: true,
    })
    logger.info("identifyRoots defaulted to single root ./")
    return { roots: ["./"] }
  }

  logger.set({
    step: "codeIngestion.identifyRoots.summary",
    repositoryId,
    targetHash,
    rootsCount: roots.length,
    roots,
    defaultedToRepoRoot: false,
  })
  logger.info("identifyRoots summary")

  return { roots }
}
