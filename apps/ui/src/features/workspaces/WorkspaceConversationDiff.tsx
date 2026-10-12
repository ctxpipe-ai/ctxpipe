import { parseDiffFromFile } from "@pierre/diffs"
import { FileDiff } from "@pierre/diffs/react"
import {
  IconChevronRight,
  IconCopy,
  IconGitBranch,
  IconLayoutColumns,
  IconLayoutRows,
  IconRefresh,
  IconSelector,
  IconSquareArrowRight,
  IconSquareDot,
  IconSquareMinus,
  IconSquarePlus,
  IconTextWrap,
} from "@tabler/icons-react"
import { useSuspenseQuery } from "@tanstack/react-query"
import { type ReactNode, useCallback, useMemo, useState } from "react"
import {
  Button as AriaButton,
  ToggleButton as AriaToggleButton,
  Disclosure,
  DisclosureGroup,
  DisclosurePanel,
  type Key,
  Tooltip,
  TooltipTrigger,
} from "react-aria-components"
import { Toolbar } from "@/components/ui/Toolbar"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import { formatLineCount } from "./conversationDiff"
import { conversationGitDiffOptions } from "./queries"
import type { ChangedFile, ConversationGitDiffItem } from "./types"

/** The empty Diff pane. It needs no request, so it also shows before the sandbox is ready. */
export function ConversationDiffEmpty(props: { base: string | null }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
      <p className="text-sm font-medium text-foreground">
        No changes on this branch
      </p>
      <p className="text-sm text-muted-foreground">
        {props.base
          ? `This conversation has no changes against ${props.base}.`
          : "This conversation has no changes."}
      </p>
    </div>
  )
}

export function WorkspaceConversationDiffPane(props: {
  orgSlug: string
  conversationId: string
  /** Show only the changes of this turn (run id). */
  turn?: string
  /** Expand this file and scroll it into view. */
  focusPath?: string
  /** Leave the turn view and show all changes of the conversation. */
  onShowAll?: () => void
}) {
  const query = useSuspenseQuery(
    conversationGitDiffOptions(props.orgSlug, props.conversationId, props.turn),
  )
  const showAll = props.onShowAll ? (
    <AriaButton
      onPress={props.onShowAll}
      className={cn(
        "h-7 cursor-default rounded-md px-2 text-xs text-muted-foreground outline-0 hover:bg-foreground/[0.06] hover:text-foreground",
        focusVisibleClassName,
      )}
    >
      Show all changes
    </AriaButton>
  ) : null
  if (query.data.gone) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          This turn's diff is no longer available.
        </p>
        {showAll}
      </div>
    )
  }
  return (
    <ConversationDiffList
      // A new focus file resets which rows are open.
      key={`${props.turn ?? ""}:${props.focusPath ?? ""}`}
      items={query.data.items}
      base={props.turn ? null : (query.data.base ?? null)}
      focusPath={props.focusPath}
      refreshing={query.isFetching}
      onRefresh={() => void query.refetch()}
      scope={
        props.turn ? (
          <>
            <span className="px-1 text-xs font-medium text-foreground">
              One turn
            </span>
            {showAll}
          </>
        ) : null
      }
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
  const files = props.items
  const [expanded, setExpanded] = useState<Set<Key>>(
    () => new Set(props.focusPath ? [props.focusPath] : []),
  )
  const [split, setSplit] = useState(false)
  const [wrap, setWrap] = useState(false)
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const allExpanded = files.length > 0 && expanded.size === files.length

  if (files.length === 0) {
    return <ConversationDiffEmpty base={props.base} />
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <Toolbar
        aria-label="Diff options"
        className="h-10 shrink-0 flex-nowrap gap-1 border-b border-white/[0.06] px-2"
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
        >
          <IconRefresh
            className={cn("size-4", props.refreshing && "animate-spin")}
            aria-hidden
          />
        </ToolbarButton>
        <ToolbarButton
          label={allExpanded ? "Collapse all" : "Expand all"}
          onPress={() =>
            setExpanded(
              allExpanded ? new Set() : new Set(files.map((file) => file.path)),
            )
          }
        >
          <IconSelector className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarToggle label="Split view" selected={split} onChange={setSplit}>
          {split ? (
            <IconLayoutColumns className="size-4" aria-hidden />
          ) : (
            <IconLayoutRows className="size-4" aria-hidden />
          )}
        </ToolbarToggle>
        <ToolbarToggle label="Wrap lines" selected={wrap} onChange={setWrap}>
          <IconTextWrap className="size-4" aria-hidden />
        </ToolbarToggle>
      </Toolbar>
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

const STATUS_LABEL: Record<ChangedFile["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
}

const OMITTED_LABEL: Record<NonNullable<ChangedFile["omitted"]>, string> = {
  binary: "Binary file",
  too_large: "File too large to show",
  not_a_file: "Not a regular file",
}

export function ChangedFileStatusIcon(props: {
  status: ChangedFile["status"]
}) {
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
  if (props.status === "renamed")
    return (
      <IconSquareArrowRight
        className={cn(className, "text-teal-400")}
        aria-hidden
      />
    )
  return (
    <IconSquareDot className={cn(className, "text-amber-400")} aria-hidden />
  )
}

export function changedFileLabel(file: ChangedFile): string {
  const status = file.oldPath
    ? `${STATUS_LABEL[file.status]} from ${file.oldPath}`
    : STATUS_LABEL[file.status]
  return `${file.path}, ${status}`
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
  file: ConversationGitDiffItem
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
        className={cn(
          "flex h-8 items-center gap-1 rounded-md px-1",
          // The Diff opened on this file; the highlight shows which row that is.
          props.focused ? "bg-zinc-800" : "hover:bg-foreground/[0.04]",
        )}
      >
        <AriaButton
          slot="trigger"
          aria-label={changedFileLabel(file)}
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
          file.omitted ? (
            <p className="rounded-md border border-white/[0.06] px-3 py-2 text-xs text-muted-foreground">
              {OMITTED_LABEL[file.omitted]}
            </p>
          ) : (
            <ConversationFileDiff
              file={file}
              split={props.split}
              wrap={props.wrap}
            />
          )
        ) : null}
      </DisclosurePanel>
    </Disclosure>
  )
}

/** Parses the bodies only when the row is open. */
function ConversationFileDiff(props: {
  file: ConversationGitDiffItem
  split: boolean
  wrap: boolean
}) {
  const { file } = props
  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        file.oldBody == null
          ? null
          : {
              name: file.oldPath ?? file.path,
              contents: file.oldBody,
              cacheKey: `old:${file.path}`,
            },
        file.body == null
          ? null
          : {
              name: file.path,
              contents: file.body,
              cacheKey: `new:${file.path}`,
            },
      ),
    [file],
  )
  return (
    <div className="overflow-hidden rounded-md border border-white/[0.06]">
      <FileDiff
        fileDiff={fileDiff}
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
  )
}

const toolbarControlClassName = cn(
  "inline-flex size-7 shrink-0 cursor-default items-center justify-center rounded-md text-muted-foreground outline-0 transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
  focusVisibleClassName,
)

function ToolbarTooltip(props: { label: string }) {
  return (
    <Tooltip
      placement="bottom"
      offset={6}
      className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-100 shadow-md"
    >
      {props.label}
    </Tooltip>
  )
}

function ToolbarButton(props: {
  label: string
  onPress: () => void
  children: ReactNode
}) {
  return (
    <TooltipTrigger delay={200}>
      <AriaButton
        aria-label={props.label}
        onPress={props.onPress}
        className={toolbarControlClassName}
      >
        {props.children}
      </AriaButton>
      <ToolbarTooltip label={props.label} />
    </TooltipTrigger>
  )
}

function ToolbarToggle(props: {
  label: string
  selected: boolean
  onChange: (selected: boolean) => void
  children: ReactNode
}) {
  return (
    <TooltipTrigger delay={200}>
      <AriaToggleButton
        aria-label={props.label}
        isSelected={props.selected}
        onChange={props.onChange}
        className={({ isSelected }) =>
          cn(
            toolbarControlClassName,
            isSelected && "bg-foreground/[0.08] text-foreground",
          )
        }
      >
        {props.children}
      </AriaToggleButton>
      <ToolbarTooltip label={props.label} />
    </TooltipTrigger>
  )
}
