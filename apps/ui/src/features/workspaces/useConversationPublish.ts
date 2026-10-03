import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type { ConversationDetail } from "@/features/chat/types"
import {
  conversationPullRequestAction,
  conversationPullRequestVisible,
} from "./conversationPublish"
import {
  conversationGitStatusOptions,
  conversationPullRequestOptions,
  createConversationPullRequest,
  workspaceKeys,
} from "./queries"
import type { ConversationPullRequestResponse } from "./types"
import type { ConversationPublishChrome } from "./WorkspaceChatChrome"

export function conversationCreatePrMutationKey(
  orgSlug: string,
  conversationId: string,
) {
  return ["conversation-create-pr", orgSlug, conversationId] as const
}

export function useConversationPublish(input: {
  orgSlug: string
  conversationId: string
  workspaceId: string
  title: string
  statusEnabled: boolean
  pullEnabled: boolean
  fallbackPrState?: string | null
  fallbackPullUrl?: string | null
}) {
  const {
    orgSlug,
    conversationId,
    workspaceId,
    title,
    statusEnabled,
    pullEnabled,
  } = input
  const queryClient = useQueryClient()
  const statusQuery = useQuery({
    ...conversationGitStatusOptions(orgSlug, conversationId),
    enabled: statusEnabled,
  })
  const pullQuery = useQuery(
    conversationPullRequestOptions(orgSlug, conversationId, pullEnabled),
  )
  const createPrKey = conversationCreatePrMutationKey(orgSlug, conversationId)

  const createPrMutation = useMutation({
    mutationKey: createPrKey,
    mutationFn: () =>
      createConversationPullRequest(orgSlug, conversationId, { title }),
    onSuccess: (result) => {
      queryClient.setQueryData<ConversationDetail>(
        workspaceKeys.conversation(orgSlug, conversationId, workspaceId),
        (old) =>
          old
            ? {
                ...old,
                conversation: {
                  ...old.conversation,
                  lastBranch: result.branch,
                  lastChatPrNumber: result.prNumber,
                  lastChatPrUrl: result.pullUrl,
                  prState: result.prState,
                },
              }
            : old,
      )
      queryClient.setQueryData<ConversationPullRequestResponse>(
        workspaceKeys.conversationPullRequest(orgSlug, conversationId),
        result,
      )
    },
  })

  const createPrPending = useIsMutating({ mutationKey: createPrKey }) > 0
  const status = statusQuery.data ?? null
  const pullAction = conversationPullRequestAction(
    pullQuery.data?.prState ?? input.fallbackPrState,
  )

  const chrome: ConversationPublishChrome = {
    pullRequest: {
      visible:
        conversationPullRequestVisible(status, pullAction) || createPrPending,
      action: pullAction,
      pending: createPrPending,
      href: pullQuery.data?.pullUrl ?? input.fallbackPullUrl ?? null,
      onPress: () => {
        createPrMutation.mutate()
      },
    },
  }

  return { status, chrome }
}
