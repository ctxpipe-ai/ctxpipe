import { HumanMessage } from "@langchain/core/messages"
import { tool } from "langchain"
import { z } from "zod/v3"
import type { Env } from "../../config/env.js"
import { createAgent } from "../../graphs/createAgent.js"
import type {
  SlackConnection,
  SlackSyncTarget,
} from "../../models/slack-connector.js"
import { getLogger } from "../../observability/logger.js"
import { getModel } from "../../retrieval/services/modelProvider.js"
import {
  SLACK_CAPTURE_STATUS_CAPTURED,
  SLACK_CAPTURE_STATUS_FAILED,
  SLACK_MENTION_CAPABILITY_REPLY,
} from "./client.js"
import { captureSlackThread, type SlackCaptureResult } from "./sync.js"

export {
  SLACK_MENTION_CAPABILITY_REPLY,
  SLACK_MENTION_STATUS_WORKING,
} from "./client.js"

const SLACK_MENTION_SYSTEM_PROMPT = `You are ctx|'s Slack mention agent for one thread.
You have one tool: capture_thread, which snapshots this Slack thread into the organization's context git repository.

Call capture_thread when the user wants to persist, save, capture, snapshot, or keep this thread, including terse confirmations like "yes", "do it", or "please".
If the message is a question, joke, greeting, or any request you cannot fulfill with capture_thread, do not call the tool. Do not invent answers about the repository or product.`

export type SlackMentionErrorCode =
  | SlackCaptureResult["errorCode"]
  | "model_not_configured"

export type SlackMentionAgentResult =
  | { kind: "captured"; capture: SlackCaptureResult }
  | { kind: "capability" }
  | {
      kind: "failed"
      errorCode?: SlackMentionErrorCode
      error?: string
    }

export function stripSlackMentionText(text: string | undefined): string {
  return (text ?? "")
    .replace(/<@[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function isSlackModelConfigured(env: Env): boolean {
  if (env.MODEL_PROVIDER_API_KEY?.trim()) return true
  return env.MODEL_PROVIDER === "bedrock"
}

export function formatSlackMentionStatusText(
  result: SlackMentionAgentResult,
): string {
  if (result.kind === "capability") {
    return SLACK_MENTION_CAPABILITY_REPLY
  }
  if (result.kind === "captured") {
    const captured = result.capture
    const base = captured.githubUrl
      ? `${SLACK_CAPTURE_STATUS_CAPTURED} <${captured.githubUrl}|View in GitHub>`
      : SLACK_CAPTURE_STATUS_CAPTURED
    if (captured.truncated) {
      return `${base} Thread was truncated to the oldest 500 messages.`
    }
    return base
  }
  switch (result.errorCode) {
    case "not_in_channel":
      return "Capture failed: invite the bot to this channel, then mention it again."
    case "github_protected_branch":
      return "Capture failed: the context repository branch is protected, so ctx| cannot commit."
    case "repo_missing":
      return "Capture failed: the context repository is missing or is not linked to GitHub."
    case "model_not_configured":
      return "Capture failed: this deployment has no model configured (set MODEL_PROVIDER*)."
    case "dm_not_supported":
      return "Capture failed: direct messages are not supported."
    default:
      return result.error
        ? `${SLACK_CAPTURE_STATUS_FAILED} ${result.error}`
        : SLACK_CAPTURE_STATUS_FAILED
  }
}

function failedFromCapture(
  capture: SlackCaptureResult,
): SlackMentionAgentResult {
  return {
    kind: "failed",
    errorCode: capture.errorCode,
    error: capture.error,
  }
}

async function runCapture(input: {
  orgId: string
  env: Env
  connection: SlackConnection
  target: SlackSyncTarget
  channelId: string
  threadTs: string
  excludeMessageTs?: string
  capturedByUserId?: string
}): Promise<SlackMentionAgentResult> {
  const capture = await captureSlackThread(input)
  if (capture.status === "failed") return failedFromCapture(capture)
  return { kind: "captured", capture }
}

export async function runSlackMentionAgent(input: {
  orgId: string
  env: Env
  connection: SlackConnection
  target: SlackSyncTarget
  channelId: string
  threadTs: string
  mentionText?: string
  mentionUserId?: string
  excludeMessageTs?: string
}): Promise<SlackMentionAgentResult> {
  const remainder = stripSlackMentionText(input.mentionText)
  const captureInput = {
    orgId: input.orgId,
    env: input.env,
    connection: input.connection,
    target: input.target,
    channelId: input.channelId,
    threadTs: input.threadTs,
    excludeMessageTs: input.excludeMessageTs,
    capturedByUserId: input.mentionUserId,
  }

  if (remainder.length === 0) {
    return runCapture(captureInput)
  }

  if (!isSlackModelConfigured(input.env)) {
    return {
      kind: "failed",
      errorCode: "model_not_configured",
      error: "MODEL_PROVIDER is not configured",
    }
  }

  const captureState: { result?: SlackCaptureResult } = {}
  const captureThreadTool = tool(
    async () => {
      if (!captureState.result) {
        captureState.result = await captureSlackThread(captureInput)
      }
      const result = captureState.result
      if (result.status === "failed") {
        return `Capture failed: ${result.error ?? result.errorCode ?? "unknown error"}`
      }
      return "Thread captured into the context repository."
    },
    {
      name: "capture_thread",
      description:
        "Snapshot this Slack thread into the organization's context git repository.",
      schema: z.object({}),
    },
  )

  try {
    const agent = createAgent({
      model: getModel("fast", { streaming: false, temperature: 0 }),
      tools: [captureThreadTool],
      systemPrompt: SLACK_MENTION_SYSTEM_PROMPT,
    })
    await agent.invoke(
      {
        messages: [
          new HumanMessage(
            `The user mentioned the bot in a Slack thread with this extra text:\n${remainder}`,
          ),
        ],
      },
      { recursionLimit: 8 },
    )
  } catch (error) {
    getLogger().error(
      error instanceof Error ? error : new Error(String(error)),
      {
        step: "slack_mention_agent.invoke",
        connectionId: input.connection.id,
      },
    )
    if (captureState.result) {
      return captureState.result.status === "failed"
        ? failedFromCapture(captureState.result)
        : { kind: "captured", capture: captureState.result }
    }
    return {
      kind: "failed",
      errorCode: "capture_failed",
      error: error instanceof Error ? error.message : String(error),
    }
  }

  if (captureState.result) {
    return captureState.result.status === "failed"
      ? failedFromCapture(captureState.result)
      : { kind: "captured", capture: captureState.result }
  }
  return { kind: "capability" }
}
