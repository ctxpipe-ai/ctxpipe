import { useQuery } from "@tanstack/react-query"

import {
  workspaceChatPrepareOptions,
  workspaceConversationOptions,
} from "./queries"
import { useConversationPublish } from "./useConversationPublish"

export type ConversationPublish = ReturnType<typeof useConversationPublish>

/**
 * The publish state of the open conversation, made one time for the page.
 * The conversation header and the tools pane show the same actions from it.
 * The hook reads the prepare and conversation queries that the conversation
 * session runs. It does not start them.
 */
export function useWorkspaceConversationPublish(input: {
  orgSlug: string
  workspaceId: string
  conversationId?: string
}): ConversationPublish | null {
  const conversationId = input.conversationId ?? ""
  const prepareQuery = useQuery({
    ...workspaceChatPrepareOptions(
      input.orgSlug,
      conversationId,
      input.workspaceId,
    ),
    enabled: false,
  })
  const detailQuery = useQuery({
    ...workspaceConversationOptions(
      input.orgSlug,
      conversationId,
      input.workspaceId,
    ),
    enabled: false,
  })
  const conversation = detailQuery.data?.conversation
  const publish = useConversationPublish({
    orgSlug: input.orgSlug,
    conversationId,
    workspaceId: input.workspaceId,
    title: conversation?.name || "New conversation",
    statusEnabled: Boolean(input.conversationId) && prepareQuery.isSuccess,
    pullEnabled:
      Boolean(input.conversationId) &&
      (conversation?.lastChatPrNumber ?? null) != null,
    fallbackPrState: conversation?.prState,
    fallbackPullUrl: conversation?.lastChatPrUrl,
    published: Boolean(conversation?.branchTreeUrl),
  })
  return input.conversationId ? publish : null
}
