import { HumanMessage } from "@langchain/core/messages"
import { tool } from "langchain"
import { z } from "zod/v3"
import { langfusePipelineCallbacks } from "../../../observability/langfusePipelineMetrics.js"
import { getLogger } from "../../../observability/logger.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import { getFileTool } from "../../../tools/getFile.js"
import { createAgent } from "../../createAgent.js"

type Kind = "App" | "Service" | "Library"

const KindSchema = z.enum(["App", "Service", "Library"])

const MAX_PATHS_IN_PROMPT = 800

/**
 * When deterministic package.json classification is weak (Library), use a ReAct
 * agent with `get_file` and `submit_package_kind`. Each tool round is an
 * additional model call (unavoidable for on-demand file reads).
 */
export async function classifyAmbiguousPackageKindAgent(input: {
  repositoryId: string
  root: string
  pathsUnderRoot: string[]
  targetHash: string
}): Promise<Kind> {
  const captured: { value: Kind | null } = { value: null }

  const submitPackageKindTool = tool(
    async ({ kind }) => {
      captured.value = kind
      return `Recorded kind: ${kind}`
    },
    {
      name: "submit_package_kind",
      description:
        "Call exactly once with the final classification for this workspace root.",
      schema: z.object({
        kind: KindSchema.describe(
          "App = client/UI (mobile, desktop, web app, extension). Service = runnable backend, API, worker, collector, daemon, batch job. Library = shared package or utilities with no deployable runtime surface.",
        ),
      }),
    },
  )

  const sorted = [...input.pathsUnderRoot].sort()
  const listedPaths = sorted.slice(0, MAX_PATHS_IN_PROMPT)
  const omitted = sorted.length - listedPaths.length
  const omittedNote =
    omitted > 0
      ? `\n\n(${omitted} more paths omitted from this list; use get_file on paths you need.)`
      : ""

  const agent = createAgent({
    model: getModel("medium", { temperature: 0.1 }),
    tools: [getFileTool, submitPackageKindTool],
    contextMiddleware: {
      clearToolUsesTriggerTokens: 100_000,
      clearToolUsesKeepMessages: 12,
      summarizationTriggerTokens: 180_000,
      summarizationKeepMessages: 28,
    },
    systemPrompt: `You classify one workspace root in a repository into App, Service, or Library.

Definitions:
- App: end-user-facing client — mobile (React Native/Expo), desktop (Electron/Tauri), browser extension, native GUI.
- Service: deployable or long-running runtime — HTTP/gRPC APIs, workers, daemons, OpenTelemetry collectors, data pipelines, CLIs that are the primary deliverable for this root.
- Library: shared code consumed by other packages (workspace libs), or pure utilities with no standalone deployable surface.

Use get_file to read package.json, README, Dockerfile, and other manifests before deciding. Call submit_package_kind exactly once when confident.`,
  })

  const userMessage = `repositoryId: "${input.repositoryId}"
workspace root: "${input.root}"
targetHash: ${input.targetHash}

Paths under this root (relative to repository):
${listedPaths.join("\n")}${omittedNote}

Read package.json under this root first, then any Dockerfile, README, or entrypoints that clarify the role.`

  await agent.invoke(
    { messages: [new HumanMessage(userMessage)] },
    {
      recursionLimit: 80,
      callbacks: langfusePipelineCallbacks({
        step: "codeIngestion.extractKind.ambiguousPackageKind",
        dimensions: {
          repositoryId: input.repositoryId,
          targetHash: input.targetHash,
        },
      }),
    },
  )

  if (!captured.value) {
    const logger = getLogger()
    logger.set({
      step: "codeIngestion.extractKind.ambiguousPackageKind.missingSubmit",
      repositoryId: input.repositoryId,
      root: input.root,
      targetHash: input.targetHash,
    })
    logger.warn(
      "[codeIngestion] ambiguous package kind agent finished without submit_package_kind; defaulting to Library",
      { repositoryId: input.repositoryId, root: input.root },
    )
    return "Library"
  }

  return captured.value
}
