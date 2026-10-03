import { useSuspenseQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/Button"
import { conversationGitDiffOptions } from "./queries"
import type { ConversationGitDiffItem } from "./types"
import { WorkspacePierreFile } from "./WorkspacePierreFile"

export function WorkspaceConversationDiffPane(props: {
  orgSlug: string
  conversationId: string
  onOpenFile: (path: string) => void
}) {
  const { data } = useSuspenseQuery(
    conversationGitDiffOptions(props.orgSlug, props.conversationId),
  )
  if (data.items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          No changes vs the default branch.
        </p>
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-auto">
      {data.items.map((item) => (
        <ConversationDiffFile
          key={item.path}
          item={item}
          onOpen={() => props.onOpenFile(item.path)}
        />
      ))}
    </div>
  )
}

function ConversationDiffFile(props: {
  item: ConversationGitDiffItem
  onOpen: () => void
}) {
  return (
    <div className="border-b border-white/[0.06]">
      <Button
        variant="ghost"
        onPress={props.onOpen}
        className="h-8 w-full justify-start rounded-none px-3 font-mono text-xs"
      >
        {props.item.path}
      </Button>
      <div className="h-64 min-h-0">
        <WorkspacePierreFile
          path={props.item.path}
          body={props.item.body ?? ""}
          oldBody={props.item.oldBody}
          cacheKey={`diff:${props.item.path}:${props.item.body?.length ?? 0}`}
        />
      </div>
    </div>
  )
}
