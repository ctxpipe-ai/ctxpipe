import { HumanMessage } from "@langchain/core/messages"
import { mergeConfigs } from "@langchain/core/runnables"
import { getConfig } from "@langchain/langgraph"
import { tool } from "langchain"
import { z } from "zod/v3"
import { getLogger } from "../../../observability/logger.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import { getFileTool } from "../../../tools/getFile.js"
import { listFilesTool } from "../../../tools/listFiles.js"
import { createAgent } from "../../createAgent.js"
import type { CodeIngestionState } from "../schemas.js"

const ROOTS_TOOL_NAME = "submit_roots"

export type IdentifyRootsAmbiguousAgentResult = {
  roots: string[]
  source: "llm" | "partialRoots" | "repoRoot"
}

function createRootsTool(capturedRoots: { value: string[] | null }) {
  return tool(
    async ({ roots }) => {
      capturedRoots.value = roots
      return "Roots recorded successfully."
    },
    {
      name: ROOTS_TOOL_NAME,
      description:
        'Call this exactly once when you have determined roots. For single-repo use ["./"]. For monorepo use relative package/app paths.',
      schema: z.object({
        roots: z.array(z.string()).describe("Array of root paths"),
      }),
    },
  )
}

function normalizeRoots(roots: string[]): string[] {
  const normalized = roots
    .map((root) => root.trim())
    .filter((root) => root.length > 0)
    .map((root) => {
      let value = root
      if (value.startsWith("./")) value = value.slice(2)
      while (value.endsWith("/")) value = value.slice(0, -1)
      return !value || value === "." ? "./" : value
    })
  const uniq = Array.from(new Set(normalized))
  if (uniq.length === 0) return []
  const withoutRepoRoot = uniq.filter((root) => root !== "./")
  return (withoutRepoRoot.length > 0 ? withoutRepoRoot : ["./"]).sort()
}

export async function identifyRootsAmbiguousAgent(input: {
  state: CodeIngestionState
  partialRoots: string[]
  reason: string
}): Promise<IdentifyRootsAmbiguousAgentResult> {
  const { state, partialRoots, reason } = input
  const { repositoryId, targetHash } = state
  const capturedRoots: { value: string[] | null } = { value: null }
  const submitRootsTool = createRootsTool(capturedRoots)

  const agent = createAgent({
    model: getModel("fast", { streaming: false, temperature: 0.1 }),
    tools: [listFilesTool, getFileTool, submitRootsTool],
    systemPrompt: `You are resolving repository roots when deterministic parsing is ambiguous.

Use repositoryId "${repositoryId}" for all tool calls.

Workflow:
1. Use list_files for repo root and likely workspace folders.
2. Use get_file to inspect only needed manifests.
3. Call submit_roots exactly once when confident.

Rules:
- Return ["./"] only for true single-repo layout.
- For monorepo, return each package/app root (relative paths, no trailing slash).
- Prefer a compact, high-confidence answer over exhaustive scans.`,
    contextMiddleware: {
      clearToolUsesTriggerTokens: 120_000,
      clearToolUsesKeepMessages: 14,
      summarizationTriggerTokens: 200_000,
      summarizationKeepMessages: 32,
    },
  })

  const partialRootsNote =
    partialRoots.length > 0 ? partialRoots.join(", ") : "(none)"
  const userMessage = `Deterministic root detection was ambiguous.
reason: ${reason}
deterministic partialRoots: ${partialRootsNote}

Use list_files and get_file only as needed, then call ${ROOTS_TOOL_NAME}.`

  try {
    await agent.invoke(
      { messages: [new HumanMessage(userMessage)] },
      mergeConfigs(getConfig(), {
        recursionLimit: 100,
      }),
    )
  } catch (error) {
    const logger = getLogger()
    logger.warn(
      "identifyRootsAmbiguousAgent: agent invocation failed; using deterministic fallback",
      {
        repositoryId,
        targetHash,
        partialRoots,
        error: error instanceof Error ? error.message : String(error),
      },
    )
    if (partialRoots.length > 0) {
      return { roots: partialRoots, source: "partialRoots" }
    }
    return { roots: ["./"], source: "repoRoot" }
  }

  const submitted = normalizeRoots(capturedRoots.value ?? [])
  if (submitted.length > 0) {
    return { roots: submitted, source: "llm" }
  }

  const logger = getLogger()
  logger.warn(
    "identifyRootsAmbiguousAgent: finished without submit_roots; using deterministic fallback",
    { repositoryId, targetHash, partialRoots },
  )
  if (partialRoots.length > 0) {
    return { roots: partialRoots, source: "partialRoots" }
  }
  return { roots: ["./"], source: "repoRoot" }
}
