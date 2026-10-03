import { HumanMessage } from "@langchain/core/messages"
import { tool } from "langchain"
import { z } from "zod/v3"
import type { Env } from "../../config/env.js"
import { createAgent } from "../../graphs/createAgent.js"
import { getLogger } from "../../observability/logger.js"
import { getModel } from "../../retrieval/services/modelProvider.js"
import {
  SLACK_CAPTURE_STATUS_CAPTURED,
  SLACK_CAPTURE_STATUS_FAILED,
  SLACK_MENTION_CAPABILITY_REPLY,
} from "./client.js"
import type { SlackCaptureResult } from "./sync.js"

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

export type SlackMentionIntent =
  | { kind: "capture" }
  | Exclude<SlackMentionAgentResult, { kind: "captured" }>

export async function selectSlackMentionIntent(input: {
  env: Env
  connectionId: string
  mentionText?: string
}): Promise<SlackMentionIntent> {
  const remainder = stripSlackMentionText(input.mentionText)
  if (remainder.length === 0) return { kind: "capture" }
  if (!isSlackModelConfigured(input.env))
    return {
      kind: "failed",
      errorCode: "model_not_configured",
      error: "MODEL_PROVIDER is not configured",
    }
  let captureRequested = false
  const captureThreadTool = tool(
    async () => {
      captureRequested = true
      return "Thread capture requested. The durable workflow will publish it."
    },
    {
      name: "capture_thread",
      description:
        "Request a snapshot of this Slack thread into the organization's context git repository.",
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
      { step: "slack_mention_agent.invoke", connectionId: input.connectionId },
    )
    if (!captureRequested)
      return {
        kind: "failed",
        errorCode: "capture_failed",
        error: error instanceof Error ? error.message : String(error),
      }
  }
  return captureRequested ? { kind: "capture" } : { kind: "capability" }
}
