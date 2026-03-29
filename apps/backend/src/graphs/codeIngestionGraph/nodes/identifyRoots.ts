import { HumanMessage } from "@langchain/core/messages"
import { tool } from "langchain"
import { z } from "zod/v3"
import { langfusePipelineCallbacks } from "../../../observability/langfusePipelineMetrics.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import {
  REPO_EXPLORER_TOOLS_HINT,
  standardRepoExplorerTools,
} from "../../../tools/repoExplorerTools.js"
import { createAgent } from "../../createAgent.js"
import type { CodeIngestionState } from "../schemas.js"
import { narrowRootsForPartialDiff } from "./narrowRootsForPartialDiff.js"

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

function hasPartialDiffPaths(state: CodeIngestionState): boolean {
  const changed = state.changedPaths?.length ?? 0
  const deleted = state.deletedPaths?.length ?? 0
  const renames = state.renames?.length ?? 0
  return changed + deleted + renames > 0
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
When done, call submit_roots with the roots array.

${REPO_EXPLORER_TOOLS_HINT}`,
  })

  const userMessage = `List files at the repository root, then determine the roots. Call submit_roots with your answer.`

  const stream = await agent.stream(
    { messages: [new HumanMessage(userMessage)] },
    {
      streamMode: "values",
      callbacks: langfusePipelineCallbacks({
        step: "codeIngestion.identifyRoots",
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
      // Agent is running - continue until done
    }
  }

  const roots = capturedRoots.value
  const resolved = !roots || roots.length === 0 ? ["./"] : roots

  if (state.ingestMode === "partial" && hasPartialDiffPaths(state)) {
    const narrowed = narrowRootsForPartialDiff(
      resolved,
      state.changedPaths,
      state.deletedPaths,
      state.renames,
    )
    if (narrowed.length > 0) {
      return { roots: narrowed }
    }
  }

  return { roots: resolved }
}
