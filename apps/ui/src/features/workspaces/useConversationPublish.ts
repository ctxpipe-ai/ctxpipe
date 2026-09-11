import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type { ConversationDetail } from "@/features/chat/types"
import {
  conversationCommitPushEnabled,
  conversationPullRequestAction,
} from "./conversationPublish"
import {
  conversationGitStatusOptions,
  conversationPullRequestOptions,
  createConversationPullRequest,
  pushConversationBranch,
  workspaceKeys,
} from "./queries"
import type {
  ConversationGitStatusResponse,
  ConversationPullRequestResponse,
} from "./types"
import type { ConversationPublishChrome } from "./WorkspaceChatChrome"

export function conversationPushMutationKey(
  orgSlug: string,
  conversationId: string,
) {
  return ["conversation-push", orgSlug, conversationId] as const
}

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
  const pushKey = conversationPushMutationKey(orgSlug, conversationId)
  const createPrKey = conversationCreatePrMutationKey(orgSlug, conversationId)

  const pushMutation = useMutation({
    mutationKey: pushKey,
    mutationFn: () => pushConversationBranch(orgSlug, conversationId),
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
                  branchTreeUrl: result.treeUrl,
                },
              }
            : old,
      )
      queryClient.setQueryData<ConversationGitStatusResponse>(
        workspaceKeys.conversationGitStatus(orgSlug, conversationId),
        (old) =>
          old
            ? { ...old, unpushed: false, published: true, dirty: false }
            : old,
      )
    },
  })
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

  const pushPending = useIsMutating({ mutationKey: pushKey }) > 0
  const createPrPending = useIsMutating({ mutationKey: createPrKey }) > 0
  const status = statusQuery.data ?? null

  const chrome: ConversationPublishChrome = {
    commitPush: {
      enabled: conversationCommitPushEnabled(status),
      pending: pushPending,
      onPress: () => {
        pushMutation.mutate()
      },
    },
    pullRequest: {
      action: conversationPullRequestAction(
        pullQuery.data?.prState ?? input.fallbackPrState,
      ),
      pending: createPrPending,
      href: pullQuery.data?.pullUrl ?? input.fallbackPullUrl ?? null,
      onPress: () => {
        createPrMutation.mutate()
      },
    },
  }

  return { status, chrome }
}
