import { chat } from "@tanstack/ai"
import { z } from "zod"
import type { Env } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { abortAfter } from "../../lib/abortAfter.js"
import { getOrganizationSlugByOrgId } from "../../models/organizations.js"
import { getWorkspaceById } from "../../models/workspaces.js"
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
Decide whether the user wants ctx| to capture this Slack thread into the organization's context git repository.

Set capture to true when the user wants to persist, save, capture, snapshot, or keep this thread, including terse confirmations like "yes", "do it", or "please".
Set capture to false if the message is a question, joke, greeting, or any request that capture cannot fulfill. Do not invent answers about the repository or product.`

export type SlackMentionErrorCode =
  | SlackCaptureResult["errorCode"]
  | "model_not_configured"
  /** No Workspace has a Slack source with the channel (ADR-050). */
  | "no_source"

export type SlackMentionAgentResult =
  | {
      kind: "captured"
      capture: SlackCaptureResult
      /** The Workspaces that got the thread through their sources. */
      workspaces?: SlackCaptureWorkspaceLink[]
    }
  | { kind: "capability" }
  | {
      kind: "failed"
      errorCode?: SlackMentionErrorCode
      error?: string
    }

/** A Workspace that got a capture, and its thread file in the app. */
export type SlackCaptureWorkspaceLink = { name: string; url: string }

/**
 * The thread file in each Workspace, at the public origin `AUTH_BASE_URL`.
 * The link opens the file in the Workspace, where the user can edit it.
 */
export async function slackCaptureWorkspaceLinks(input: {
  orgId: string
  workspaceIds: readonly string[]
  threadPath: string
  env: Env
}): Promise<SlackCaptureWorkspaceLink[]> {
  const orgSlug = await getOrganizationSlugByOrgId(input.orgId)
  if (!orgSlug) return []
  const origin = input.env.AUTH_BASE_URL.replace(/\/+$/, "")
  const pane = encodeURIComponent(
    `file:${encodeURIComponent(input.threadPath)}`,
  )
  const workspaces = await withOrgDbContext(input.orgId, () =>
    Promise.all(
      input.workspaceIds.map((id) => getWorkspaceById(id, input.orgId)),
    ),
  )
  return workspaces.flatMap((workspace) =>
    workspace
      ? [
          {
            name: workspace.displayName,
            url: `${origin}/${orgSlug}/ws/${workspace.slug}?pane=${pane}`,
          },
        ]
      : [],
  )
}

/** Slack mrkdwn treats `&`, `<` and `>` as control characters. */
function escapeSlackText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
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
    const links = result.workspaces ?? []
    const done = links.length
      ? `Engineering context captured into ${links
          .map((link) => `<${link.url}|${escapeSlackText(link.name)}>`)
          .join(", ")}.`
      : SLACK_CAPTURE_STATUS_CAPTURED
    const base = captured.githubUrl
      ? `${done} <${captured.githubUrl}|View in GitHub>`
      : done
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
    case "missing_scope":
      return "Capture failed: the ctx| Slack app needs more permissions to read this channel. Reinstall Slack."
    case "channel_archived":
      return "Capture failed: this channel is archived."
    case "no_source":
      return "Nothing captured: no Workspace has this channel. Add the channel to a Slack source in the Workspace settings. If that opens a pull request, merge it. Then mention me again."
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
  try {
    const { capture } = await chat({
      adapter: getModel("fast", {
        name: "slack.mention-intent",
        outputName: "mention_intent",
        temperature: 0,
      }),
      systemPrompts: [SLACK_MENTION_SYSTEM_PROMPT],
      messages: [
        {
          role: "user",
          content: `The user mentioned the bot in a Slack thread with this extra text:\n${remainder}`,
        },
      ],
      outputSchema: z.object({ capture: z.boolean() }),
      abortController: abortAfter(30_000),
      stream: false,
    })
    return capture ? { kind: "capture" } : { kind: "capability" }
  } catch (error) {
    getLogger().error(
      error instanceof Error ? error : new Error(String(error)),
      { step: "slack_mention_agent.invoke", connectionId: input.connectionId },
    )
    return {
      kind: "failed",
      errorCode: "capture_failed",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
