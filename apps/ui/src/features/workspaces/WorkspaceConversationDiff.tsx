import { FileDiff } from "@pierre/diffs/react"
import {
  IconChevronRight,
  IconCopy,
  IconGitBranch,
  IconLayoutColumns,
  IconLayoutRows,
  IconRefresh,
  IconSelector,
  IconSquareDot,
  IconSquareMinus,
  IconSquarePlus,
  IconTextWrap,
} from "@tabler/icons-react"
import { useSuspenseQuery } from "@tanstack/react-query"
import { type ReactNode, useCallback, useMemo, useState } from "react"
import {
  Button as AriaButton,
  Disclosure,
  DisclosureGroup,
  DisclosurePanel,
  type Key,
} from "react-aria-components"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import {
  type ChangedFileStatus,
  type ConversationDiffFile,
  conversationDiffFiles,
  formatLineCount,
} from "./conversationDiff"
import { conversationGitDiffOptions } from "./queries"
import type { ConversationGitDiffItem } from "./types"

export function WorkspaceConversationDiffPane(props: {
  orgSlug: string
  conversationId: string
  /** Expand this file and scroll it into view. */
  focusPath?: string
}) {
  const query = useSuspenseQuery(
    conversationGitDiffOptions(props.orgSlug, props.conversationId),
  )
  return (
    <ConversationDiffList
      // A new focus file resets which rows are open.
      key={props.focusPath ?? ""}
      items={query.data.items}
      base={query.data.base ?? null}
      focusPath={props.focusPath}
      refreshing={query.isFetching}
      onRefresh={() => void query.refetch()}
    />
  )
}

export function ConversationDiffList(props: {
  items: ConversationGitDiffItem[]
  base: string | null
  focusPath?: string
  refreshing?: boolean
  onRefresh: () => void
  /** Extra header content before the base, such as a scope label. */
  scope?: ReactNode
}) {
  const files = useMemo(() => conversationDiffFiles(props.items), [props.items])
  const [expanded, setExpanded] = useState<Set<Key>>(
    () => new Set(props.focusPath ? [props.focusPath] : []),
  )
  const [split, setSplit] = useState(false)
  const [wrap, setWrap] = useState(false)
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const allExpanded = files.length > 0 && expanded.size === files.length

  if (files.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
        <p className="text-sm font-medium text-foreground">No changes</p>
        <p className="text-sm text-muted-foreground">
          {props.base
            ? `This conversation has no changes against ${props.base}.`
            : "This conversation has no changes."}
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <TooltipProvider delay={200}>
        <div
          role="toolbar"
          aria-label="Diff options"
          className="flex h-10 shrink-0 items-center gap-1 border-b border-white/[0.06] px-2"
        >
          {props.scope}
          {props.base ? (
            <span className="flex min-w-0 items-center gap-1 px-1 font-mono text-xs text-muted-foreground">
              <IconGitBranch className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{props.base}</span>
            </span>
          ) : null}
          <LineCounts
            additions={additions}
            deletions={deletions}
            label="Total"
            className="px-1"
          />
          <span className="flex-1" />
          <ToolbarButton
            label={props.refreshing ? "Refreshing" : "Refresh"}
            onPress={props.onRefresh}
            icon={
              <IconRefresh
                className={cn("size-4", props.refreshing && "animate-spin")}
                aria-hidden
              />
            }
          />
          <ToolbarButton
            label={allExpanded ? "Collapse all" : "Expand all"}
            onPress={() =>
              setExpanded(
                allExpanded
                  ? new Set()
                  : new Set(files.map((file) => file.path)),
              )
            }
            icon={<IconSelector className="size-4" aria-hidden />}
          />
          <ToolbarButton
            label="Split view"
            pressed={split}
            onPress={() => setSplit(!split)}
            icon={
              split ? (
                <IconLayoutColumns className="size-4" aria-hidden />
              ) : (
                <IconLayoutRows className="size-4" aria-hidden />
              )
            }
          />
          <ToolbarButton
            label="Wrap lines"
            pressed={wrap}
            onPress={() => setWrap(!wrap)}
            icon={<IconTextWrap className="size-4" aria-hidden />}
          />
        </div>
      </TooltipProvider>
      <DisclosureGroup
        aria-label="Changed files"
        allowsMultipleExpanded
        expandedKeys={expanded}
        onExpandedChange={setExpanded}
        className="min-h-0 flex-1 overflow-auto py-1"
      >
        {files.map((file) => (
          <ConversationDiffRow
            key={file.path}
            file={file}
            expanded={expanded.has(file.path)}
            focused={file.path === props.focusPath}
            split={split}
            wrap={wrap}
          />
        ))}
      </DisclosureGroup>
    </div>
  )
}

const STATUS_LABEL: Record<ChangedFileStatus, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
}

export function ChangedFileStatusIcon(props: { status: ChangedFileStatus }) {
  const className = "size-4 shrink-0"
  if (props.status === "added")
    return (
      <IconSquarePlus
        className={cn(className, "text-emerald-400")}
        aria-hidden
      />
    )
  if (props.status === "deleted")
    return (
      <IconSquareMinus className={cn(className, "text-red-400")} aria-hidden />
    )
  return (
    <IconSquareDot className={cn(className, "text-amber-400")} aria-hidden />
  )
}

export function LineCounts(props: {
  additions: number
  deletions: number
  label?: string
  className?: string
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums",
        props.className,
      )}
    >
      <span className="sr-only">
        {props.label ? `${props.label}: ` : ""}
        {props.additions} added, {props.deletions} removed
      </span>
      <span className="text-emerald-400" aria-hidden>
        +{formatLineCount(props.additions)}
      </span>
      <span className="text-red-400" aria-hidden>
        −{formatLineCount(props.deletions)}
      </span>
    </span>
  )
}

/** Shows the end of a long path: the start is cut and replaced with "…". */
export function TailTruncatedPath(props: { path: string; className?: string }) {
  return (
    <span
      dir="rtl"
      title={props.path}
      className={cn("min-w-0 truncate text-left font-mono", props.className)}
    >
      <bdi dir="ltr">{props.path}</bdi>
    </span>
  )
}

function ConversationDiffRow(props: {
  file: ConversationDiffFile
  expanded: boolean
  focused: boolean
  split: boolean
  wrap: boolean
}) {
  const { file } = props
  const [copied, setCopied] = useState(false)
  const scrollWhenFocused = useCallback(
    (node: HTMLDivElement | null) => {
      if (props.focused) node?.scrollIntoView({ block: "start" })
    },
    [props.focused],
  )
  return (
    <Disclosure id={file.path} className="group/row">
      <div
        ref={scrollWhenFocused}
        className="flex h-8 items-center gap-1 rounded-md px-1 hover:bg-foreground/[0.04]"
      >
        <AriaButton
          slot="trigger"
          aria-label={`${file.path}, ${STATUS_LABEL[file.status]}`}
          className={cn(
            "flex h-7 min-w-0 flex-1 cursor-default items-center gap-2 rounded-md px-1 text-left text-xs text-foreground outline-0",
            focusVisibleClassName,
          )}
        >
          <IconChevronRight
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              props.expanded && "rotate-90",
            )}
            aria-hidden
          />
          <ChangedFileStatusIcon status={file.status} />
          <TailTruncatedPath path={file.path} />
        </AriaButton>
        <AriaButton
          aria-label={copied ? "Path copied" : `Copy path ${file.path}`}
          onPress={() => {
            void navigator.clipboard?.writeText(file.path)
            setCopied(true)
          }}
          className={cn(
            "flex size-7 shrink-0 cursor-default items-center justify-center rounded-md text-muted-foreground outline-0 hover:bg-foreground/[0.06] hover:text-foreground",
            focusVisibleClassName,
          )}
        >
          <IconCopy className="size-3.5" aria-hidden />
        </AriaButton>
        <LineCounts
          additions={file.additions}
          deletions={file.deletions}
          className="w-24 justify-end pr-2"
        />
      </div>
      <DisclosurePanel className="px-1 pb-2">
        {props.expanded ? (
          <div className="overflow-hidden rounded-md border border-white/[0.06]">
            <FileDiff
              fileDiff={file.diff}
              options={{
                theme: { dark: "pierre-dark", light: "pierre-light" },
                disableFileHeader: true,
                diffStyle: props.split ? "split" : "unified",
                overflow: props.wrap ? "wrap" : "scroll",
              }}
              disableWorkerPool
              className="block"
            />
          </div>
        ) : null}
      </DisclosurePanel>
    </Disclosure>
  )
}

function ToolbarButton(props: {
  label: string
  icon: ReactNode
  onPress: () => void
  pressed?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={props.label}
        aria-pressed={props.pressed}
        onClick={props.onPress}
        className={cn(
          "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
          props.pressed && "bg-foreground/[0.08] text-foreground",
          focusVisibleClassName,
        )}
      >
        {props.icon}
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={6}
        className="border-0 bg-zinc-800 text-zinc-100 shadow-md"
        arrowClassName="bg-zinc-800 fill-zinc-800"
      >
        {props.label}
      </TooltipContent>
    </Tooltip>
  )
}
