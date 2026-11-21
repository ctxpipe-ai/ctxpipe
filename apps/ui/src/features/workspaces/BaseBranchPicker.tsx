import {
  IconCheck,
  IconChevronDown,
  IconGitBranch,
  IconSearch,
} from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { useId } from "react"
import {
  Autocomplete,
  SearchField as AriaSearchField,
  Input,
  ListBox,
  ListBoxItem,
  Select,
  SelectValue,
  useFilter,
} from "react-aria-components"

import { Button } from "@/components/ui/Button"
import { dropdownItemStylesDark } from "@/components/ui/ListBox"
import { Popover } from "@/components/ui/Popover"
import {
  SKELETON_ROW_OPACITY,
  SkeletonRow,
  useSkeletonHold,
} from "@/components/ui/Skeleton"
import { cn } from "@/lib/utils"

import { BranchName } from "./BranchName"
import { workspaceBranchesOptions } from "./queries"

/**
 * The branch that a new conversation starts from (ADR-071), as a quiet
 * control in the composer footer. The session branch of the conversation
 * starts from it, and its pull request targets it. The value shows at once:
 * before a pick it is the default branch of the Workspace, which the
 * Workspace read carries. Only the menu waits for the branch list. The base
 * is fixed after the first message, as in other coding agents.
 */
export function BaseBranchPicker(props: {
  orgSlug: string
  workspaceSlug: string
  /** The default branch from the Workspace read; `null` before its first tip read. */
  defaultBranch: string | null
  /** The picked base branch; `undefined` is the default branch. */
  value?: string
  onChange: (branch: string) => void
}) {
  const branches = useQuery(
    workspaceBranchesOptions(props.orgSlug, props.workspaceSlug),
  )
  const { contains } = useFilter({ sensitivity: "base" })
  const descriptionId = useId()
  const listLoading = !branches.data && branches.isFetching
  const showSkeleton = useSkeletonHold(listLoading)
  const defaultBranch = branches.data?.defaultBranch ?? props.defaultBranch
  // Before the first tip read, no branch is known. The first message then
  // starts from the default branch, as before the picker.
  if (!defaultBranch) return null
  const value = props.value ?? defaultBranch
  // Until the list loads, the menu holds the branches that are known.
  const names = branches.data?.branches ?? [...new Set([defaultBranch, value])]

  return (
    <Select
      aria-label="Base branch"
      selectedKey={value}
      onSelectionChange={(key) => {
        if (key !== null) props.onChange(String(key))
      }}
      className="min-w-0"
    >
      {/* Muted, in the UI font and at normal weight at rest (the composer
          footer sets medium), so that the prompt and the send button lead.
          Hover and the open menu brighten it. */}
      <Button
        variant="quiet"
        size="sm"
        aria-describedby={descriptionId}
        className="max-w-80 min-w-0 gap-1.5 px-1.5 font-normal aria-expanded:bg-foreground/[0.06] aria-expanded:text-foreground max-sm:max-w-60"
      >
        <IconGitBranch
          aria-hidden
          className="size-3.5 shrink-0"
          stroke={1.75}
        />
        <SelectValue className="min-w-0">
          {() => <BranchName name={value} className="font-sans" />}
        </SelectValue>
        <IconChevronDown aria-hidden className="size-3 shrink-0" stroke={2} />
      </Button>
      <span id={descriptionId} className="sr-only">
        The conversation starts from this branch, and its pull request targets
        it.
      </span>
      {/* The trigger sits 16px above the bottom edge of the composer: the
          offset puts the menu 8px below that edge, the gap of each popover. */}
      <Popover
        placement="bottom start"
        offset={24}
        className="flex w-72 max-w-[calc(100vw-2rem)] flex-col"
      >
        <Autocomplete filter={contains}>
          {/* Not the house SearchField: its bordered box in the bordered
              popover is a second frame. A menu search is one row with a
              hairline under it. */}
          <AriaSearchField
            autoFocus
            aria-label="Search branches"
            className="flex h-10 items-center gap-2 border-b border-white/10 px-4"
          >
            <IconSearch
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
              stroke={1.75}
            />
            <Input
              placeholder="Search branches"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-0 placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            />
          </AriaSearchField>
          <ListBox
            items={names.map((name) => ({ id: name }))}
            aria-label="Branches"
            className="max-h-64 overflow-y-auto p-1 outline-0"
            renderEmptyState={({ isEmpty }) =>
              isEmpty && !listLoading ? (
                <p className="flex h-7 items-center px-3 text-xs text-muted-foreground">
                  No branch matches your search.
                </p>
              ) : null
            }
          >
            {(item) => (
              <ListBoxItem
                id={item.id}
                textValue={item.id}
                className={(renderProps) =>
                  dropdownItemStylesDark({
                    ...renderProps,
                    // The check marks the selected branch. The fill
                    // marks only the focused row, so one row looks active.
                    className:
                      "h-7 gap-2 bg-transparent px-3 py-0 selected:pr-3",
                  })
                }
              >
                {({ isSelected }) => (
                  <>
                    <span className="flex w-4 shrink-0 items-center">
                      {isSelected ? (
                        <IconCheck aria-hidden className="size-4" />
                      ) : null}
                    </span>
                    <BranchName name={item.id} className="flex-1 text-xs" />
                    {item.id === defaultBranch ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        default
                      </span>
                    ) : null}
                  </>
                )}
              </ListBoxItem>
            )}
          </ListBox>
        </Autocomplete>
        {listLoading || showSkeleton ? (
          // The rows of a list that loads continue the list: the same height
          // and the same inset as a branch row.
          <div aria-busy className="-mt-1 px-1 pb-1">
            <span className="sr-only">Loading branches</span>
            {SKELETON_ROW_OPACITY.map((opacity) => (
              <SkeletonRow key={opacity} className={cn("h-7 px-3", opacity)} />
            ))}
          </div>
        ) : branches.isError ? (
          <div className="flex h-10 items-center gap-2 border-t border-white/10 pr-2.5 pl-4">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              The other branches did not load.
            </p>
            <Button
              variant="quiet"
              size="sm"
              className="px-1.5"
              onPress={() => void branches.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : null}
      </Popover>
    </Select>
  )
}
