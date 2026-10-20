import { conversationBranchPushTool } from "./conversation-branch-push.js"
import {
  WORKSPACE_CHAT_TOOLS,
  type WorkspaceChatTanstackTool,
  withToolCallSpan,
} from "./workspace-chat-tools.js"

/**
 * The tool list that the chat engine receives for a workspace chat turn. Each
 * tool runs in a tool call span, the push tool too.
 */
export function workspaceChatEngineTools(
  branchPush: Parameters<typeof conversationBranchPushTool>[0],
): WorkspaceChatTanstackTool[] {
  return [...WORKSPACE_CHAT_TOOLS, conversationBranchPushTool(branchPush)].map(
    withToolCallSpan,
  )
}
