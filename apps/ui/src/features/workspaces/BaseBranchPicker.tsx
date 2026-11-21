import { useQuery } from "@tanstack/react-query"

import { ComboBox, ComboBoxItem } from "@/components/ui/ComboBox"
import { Skeleton, useSkeletonHold } from "@/components/ui/Skeleton"

import { workspaceBranchesOptions } from "./queries"

/**
 * The branch that a new conversation starts from (ADR-071). The session
 * branch of the conversation starts from it, and its pull request targets
 * it. `value` undefined is the default branch of the Workspace. The base
 * is fixed after the first message, as in other coding agents.
 */
export function BaseBranchPicker(props: {
  orgSlug: string
  workspaceSlug: string
  value?: string
  onChange: (branch: string | undefined) => void
}) {
  const branches = useQuery(
    workspaceBranchesOptions(props.orgSlug, props.workspaceSlug),
  )
  const showSkeleton = useSkeletonHold(branches.isPending)
  if (branches.isPending || showSkeleton)
    return <Skeleton className="h-8 w-56" />
  // Without the list, the conversation starts from the default branch, as
  // before the picker: the picker does not block the message.
  if (!branches.data) return null
  const { defaultBranch } = branches.data
  return (
    <ComboBox
      label="Base"
      items={branches.data.branches.map((name) => ({ id: name }))}
      selectedKey={props.value ?? defaultBranch}
      onSelectionChange={(key) => {
        if (key === null) return
        const branch = String(key)
        props.onChange(branch === defaultBranch ? undefined : branch)
      }}
      emptyText="No branch matches"
      labelClassName="text-xs text-muted-foreground"
      inputClassName="font-mono text-xs"
      className="w-56 flex-row items-center gap-2"
    >
      {(item) => (
        <ComboBoxItem id={item.id} textValue={item.id}>
          <span className="truncate font-mono text-xs">{item.id}</span>
          {item.id === defaultBranch ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              default
            </span>
          ) : null}
        </ComboBoxItem>
      )}
    </ComboBox>
  )
}
