/**
 * The compact source list of Workspace settings. Each connector is an
 * accordion. Each source is a two-line row (the name, then its file) with ONE
 * status: the live work when there is some, else the state, quiet when
 * healthy. A problem shows before the live work. The runs of a busy source
 * open under the row. Headers, rows, and runs share one column grid, so the
 * status dots, the times, and the actions line up.
 */
import { IconChevronRight, IconDots, IconPlus } from "@tabler/icons-react"
import { type ComponentType, type ReactNode, useState } from "react"
import {
  Button as AriaButton,
  Disclosure as AriaDisclosure,
  DisclosurePanel as AriaDisclosurePanel,
  Tooltip,
  TooltipTrigger,
} from "react-aria-components"

import { Button } from "@/components/ui/Button"
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/Menu"
import { formatElapsed } from "@/features/workspace-upgrades/upgrade-progress"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { useNow } from "@/lib/useNow"
import { cn } from "@/lib/utils"

/** One run of a source, with the detail of today's "Ingesting now" list. */
export type SourceLiveRun = {
  key: string
  /** The stage as a sentence, for example "Reading the code". */
  label: string
  /** For example "1 of 3 parts done". */
  count: string | null
  /** From 0 to 1; null when the run does not count its parts. */
  fraction: number | null
  /** Why the run waits, or what it does now. */
  detail: string | null
  since: string
}

/** The live work of one source. */
export type SourceLiveStatus = {
  /** A short word for the work, for example "Syncing" or "Reading the code". */
  label: string
  /** The start of the oldest run. */
  since: string
  runs: SourceLiveRun[]
}

/** Finds the live work of a GitHub repository row or of a provider group. */
export type SourceLiveStatusLookup = {
  repository: (title: string) => SourceLiveStatus | null
  provider: (provider: string) => SourceLiveStatus | null
}

type SourceStateTone = "ok" | "attention" | "error" | "neutral"

/** One entry of the row menu, for example Edit, Rename, Remove, or Unlink. */
type SourceRowAction = {
  id: string
  label: string
  onAction: () => void
  isDisabled?: boolean
}

const TONE: Record<SourceStateTone, { dot: string; text: string }> = {
  ok: { dot: "bg-zinc-500", text: "text-muted-foreground" },
  neutral: { dot: "bg-zinc-500", text: "text-muted-foreground" },
  attention: { dot: "bg-amber-400", text: "text-amber-200" },
  error: { dot: "bg-red-400", text: "text-red-300" },
}

/**
 * The columns of a header, a row, and a run: the name, the status, the time,
 * the runs, and the action. On a narrow pane each column takes its content.
 */
const GRID =
  "grid grid-cols-[minmax(0,1fr)_auto_auto_auto_2rem] items-center gap-x-3 @3xl:grid-cols-[minmax(0,1fr)_8.5rem_4.5rem_4.5rem_2rem]"

/** The status cell: the live work first; else the state, colored only for a problem. */
function StatusCell(props: {
  state: { label: string; tone: SourceStateTone }
  live: SourceLiveStatus | null
}) {
  const { live, state } = props
  const tone = TONE[state.tone]
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap",
        live ? "text-foreground" : tone.text,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          live ? "ctx-status-pulse bg-teal-400" : tone.dot,
        )}
      />
      <span className="truncate">{live ? live.label : state.label}</span>
    </span>
  )
}

/** The time of live work, so the times of all rows line up on the right. */
function Elapsed(props: { since: string }) {
  const now = useNow(true)
  return (
    <span className="text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
      {formatElapsed(props.since, now)}
    </span>
  )
}

/**
 * A source: the name, its file under it, one status line, and its actions.
 * The actions stay quiet until the row has the pointer or the focus.
 */
export function CompactSourceRow(props: {
  title: ReactNode
  /** A short string for the run list label. */
  name: string
  subtitle: ReactNode
  state: { label: string; tone: SourceStateTone }
  live: SourceLiveStatus | null
  actions: SourceRowAction[]
  /** Lines under the row: a status detail, a pending merge, a description. */
  note?: ReactNode
}) {
  const [runsOpen, setRunsOpen] = useState(false)
  const runs = props.live?.runs ?? []
  // A problem stays visible while ctxpipe works: the work moves under the row.
  const problem =
    props.state.tone === "attention" || props.state.tone === "error"
  const live = problem ? null : props.live
  return (
    // The row starts under the connector name (chevron, icon, gaps), so the
    // sources read as children of their connector on a wide list.
    <li className="group/row py-2.5 pr-3 pl-3 hover:bg-foreground/[0.03] @xl:pl-20">
      <div className={GRID}>
        <div className="min-w-0">
          <div className="truncate text-sm text-foreground">{props.title}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">
            {props.subtitle}
          </div>
        </div>
        <StatusCell state={props.state} live={live} />
        {live ? <Elapsed since={live.since} /> : <span />}
        <div>
          {runs.length > 0 ? (
            <AriaButton
              aria-expanded={runsOpen}
              aria-label={`${runsOpen ? "Hide" : "Show"} the ${runs.length} runs of ${props.name}`}
              onPress={() => setRunsOpen((open) => !open)}
              className={cn(
                "inline-flex items-center gap-0.5 rounded-md text-xs text-muted-foreground hover:text-foreground",
                focusVisibleClassName,
              )}
            >
              {runs.length} {runs.length === 1 ? "run" : "runs"}
              <IconChevronRight
                aria-hidden
                className={cn(
                  "size-3.5 transition-transform",
                  runsOpen && "rotate-90",
                )}
              />
            </AriaButton>
          ) : null}
        </div>
        <div className="flex justify-end">
          {props.actions.length ? (
            <MenuTrigger placement="bottom end">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions of ${props.name}`}
                className="text-muted-foreground opacity-60 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
              >
                <IconDots className="size-4" aria-hidden />
              </Button>
              <Menu
                onAction={(key) =>
                  props.actions.find((action) => action.id === key)?.onAction()
                }
              >
                {props.actions.map((action) => (
                  <MenuItem
                    key={action.id}
                    id={action.id}
                    {...(action.isDisabled ? { isDisabled: true } : {})}
                  >
                    {action.label}
                  </MenuItem>
                ))}
              </Menu>
            </MenuTrigger>
          ) : null}
        </div>
      </div>
      {problem && props.live ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className="ctx-status-pulse size-1.5 shrink-0 rounded-full bg-teal-400"
          />
          {props.live.label} now
        </p>
      ) : null}
      {props.note ? <div className="mt-1 text-xs">{props.note}</div> : null}
      {runsOpen ? <RunList runs={runs} /> : null}
    </li>
  )
}

/**
 * The runs under a row, as in today's "Ingesting now" list: the stage and
 * the count, a bar, why the run waits, and the time in the time column.
 */
function RunList(props: { runs: SourceLiveRun[] }) {
  return (
    <ul className="mt-2 flex flex-col gap-2">
      {props.runs.map((run) => (
        <li key={run.key} className={cn(GRID, "items-start text-xs")}>
          <div className="col-span-2 min-w-0 border-l border-white/[0.08] pl-3">
            <p className="text-foreground">
              {run.label}
              {run.count ? (
                <>
                  <span aria-hidden className="text-muted-foreground">
                    {" · "}
                  </span>
                  <span className="text-muted-foreground">{run.count}</span>
                </>
              ) : null}
            </p>
            <div
              aria-hidden
              className="mt-1 h-0.5 max-w-xs overflow-hidden rounded-full bg-white/[0.08]"
            >
              <div
                className={cn(
                  "h-full rounded-full bg-teal-400/70",
                  run.fraction === null && "ctx-status-pulse w-1/3",
                )}
                style={
                  run.fraction === null
                    ? undefined
                    : { width: `${Math.round(run.fraction * 100)}%` }
                }
              />
            </div>
            {run.detail ? (
              <p className="mt-1 text-muted-foreground">{run.detail}</p>
            ) : null}
          </div>
          <Elapsed since={run.since} />
        </li>
      ))}
    </ul>
  )
}

/** The add action of a connector: an icon in the action column, its name in a tooltip. */
export function SourceGroupAddButton(props: {
  label: string
  onPress: () => void
}) {
  return (
    <TooltipTrigger delay={200}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={props.label}
        onPress={props.onPress}
        className="text-muted-foreground hover:text-foreground"
      >
        <IconPlus className="size-4" aria-hidden />
      </Button>
      <Tooltip
        placement="top"
        offset={6}
        className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-100 shadow-md"
      >
        {props.label}
      </Tooltip>
    </TooltipTrigger>
  )
}

/**
 * A connector as an accordion. The header holds what its rows share: the
 * connection, the count, and a summary of the live work. The action (Add)
 * sits next to the toggle, not inside it.
 */
export function SourceAccordionGroup(props: {
  id?: string
  Icon: ComponentType<{ className?: string }>
  title: string
  meta: string
  /** For example "1 working" or "1 needs attention"; null when calm. */
  summary: { label: string; tone: "working" | "attention" } | null
  note?: ReactNode
  action?: ReactNode
  /**
   * True while the connector works, needs attention, or waits for a merge.
   * The group opens when this turns true (also after the first render, when
   * the live work loads), and it stays open until the user closes it.
   */
  wantsOpen: boolean
  children?: ReactNode
}) {
  const { Icon } = props
  const linked =
    props.id !== undefined &&
    typeof window !== "undefined" &&
    window.location.hash === `#${props.id}`
  const [expanded, setExpanded] = useState(props.wantsOpen || linked)
  // Adjust the state when the prop changes, during render (no Effect).
  const [wanted, setWanted] = useState(props.wantsOpen)
  if (props.wantsOpen !== wanted) {
    setWanted(props.wantsOpen)
    if (props.wantsOpen) setExpanded(true)
  }
  return (
    <div
      id={props.id}
      ref={linked ? scrollIntoViewWhenLinked : undefined}
      className="scroll-mt-4"
    >
      <AriaDisclosure isExpanded={expanded} onExpandedChange={setExpanded}>
        {({ isExpanded }) => (
          <>
            <div className={cn(GRID, "bg-white/[0.02] px-3 py-2")}>
              <AriaButton
                slot="trigger"
                className={cn(
                  "flex min-w-0 items-center gap-3 rounded-md text-left",
                  focusVisibleClassName,
                )}
              >
                <IconChevronRight
                  aria-hidden
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform",
                    isExpanded && "rotate-90",
                  )}
                />
                <span
                  className="ctx-node size-7 shrink-0 rounded-md text-foreground"
                  aria-hidden
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm text-foreground">
                    {props.title}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {props.meta}
                  </span>
                </span>
              </AriaButton>
              {props.summary ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 text-xs whitespace-nowrap",
                    props.summary.tone === "working"
                      ? "text-teal-200"
                      : "text-amber-200",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 rounded-full",
                      props.summary.tone === "working"
                        ? "ctx-status-pulse bg-teal-400"
                        : "bg-amber-400",
                    )}
                  />
                  {props.summary.label}
                </span>
              ) : (
                <span />
              )}
              <span />
              <span />
              <div className="flex justify-end">{props.action}</div>
            </div>
            {props.note}
            <AriaDisclosurePanel>{props.children}</AriaDisclosurePanel>
          </>
        )}
      </AriaDisclosure>
    </div>
  )
}

/** A link to a connector (#source-github) scrolls to it, as WorkspaceSources does. */
function scrollIntoViewWhenLinked(element: HTMLElement | null) {
  element?.scrollIntoView({ block: "start" })
}
