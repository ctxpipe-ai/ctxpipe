/**
 * PROTOTYPE, throwaway (see prototype-variant.ts). Variant D: variant C, one
 * card for each part, made wide (the pane opens maximized). Each card states
 * its state one time, in its body. The live work of each source shows in its
 * row of the sources list, so there is no separate "running" block. The
 * header of a card shows only what its body does not: "Up to date" or
 * "Not saved".
 */
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCircleCheck,
  IconGitBranch,
  IconGitPullRequest,
  IconInfoCircle,
} from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useState } from "react"
import {
  Link as AriaLink,
  Button as AriaButton,
  Switch as AriaSwitch,
  Tooltip,
  TooltipTrigger,
} from "react-aria-components"
import { toast } from "sonner"

import { Button } from "@/components/ui/Button"
import {
  Disclosure,
  DisclosureHeader,
  DisclosurePanel,
} from "@/components/ui/Disclosure"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Link as TextLink } from "@/components/ui/Link"
import { SkeletonText, useSkeletonHold } from "@/components/ui/Skeleton"
import { TextField } from "@/components/ui/TextField"
import type {
  SourceLiveStatus,
  SourceLiveStatusLookup,
} from "@/features/workspace-sources/SourceLiveStatusCell"
import { WorkspaceSources } from "@/features/workspace-sources/WorkspaceSources"
import {
  saveWorkspaceUpgradeModeAndWait,
  workspaceUpgradeKeys,
  workspaceUpgradeModeOptions,
} from "@/features/workspace-upgrades/queries"
import { formatElapsed } from "@/features/workspace-upgrades/upgrade-progress"
import { UpgradeRunProgress } from "@/features/workspace-upgrades/UpgradeRunProgress"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { useNow } from "@/lib/useNow"
import { cn } from "@/lib/utils"

import { ingestionProgress } from "../ingestion"
import type {
  SettingsModel,
  SourceActivity,
  UpgradeView,
} from "./use-settings-model"

type PartId = "upgrades" | "sources" | "graph" | "repository"

const PART_TITLE: Record<PartId, string> = {
  upgrades: "Upgrades",
  sources: "Sources",
  graph: "Knowledge graph",
  repository: "Repository",
}

const cardId = (part: string) => `settings-d-card-${part}`

/** Moves the view and the focus to a card. */
function jumpTo(part: PartId) {
  const card = document.getElementById(cardId(part))
  if (!card) return
  card.scrollIntoView({ block: "start" })
  card.focus({ preventScroll: true })
}

export function VariantD(props: { model: SettingsModel }) {
  const { model } = props
  const upgradesLoading = useSkeletonHold(model.upgrades.status === "loading")
  const runningSources = model.activity.sources.filter(
    (source) => source.kind !== "reingest",
  )
  const graphNeedsYou =
    model.graph.status === "failed" || model.graph.skippedFiles.length > 0
  const accessNeedsYou =
    model.access.tone === "read_only" ||
    model.access.tone === "check_failed" ||
    model.access.stalled
  const upgradesNeedYou =
    model.upgrades.status === "error" ||
    model.upgrades.headline?.label === "Needs you"

  const needs: PartId[] = [
    ...(upgradesNeedYou ? (["upgrades"] as const) : []),
    ...(graphNeedsYou ? (["graph"] as const) : []),
    ...(accessNeedsYou ? (["repository"] as const) : []),
  ]
  const running: PartId[] = [
    ...(model.upgrades.working.length ? (["upgrades"] as const) : []),
    ...(runningSources.length ? (["sources"] as const) : []),
    ...(model.graph.indexingRun || model.graph.status === "running"
      ? (["graph"] as const)
      : []),
  ]

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-8 py-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-lg font-medium tracking-tight">
          Workspace settings
        </h1>
        {upgradesLoading ? (
          <SkeletonText className="text-sm" boneClassName="w-72" />
        ) : (
          <SummaryLine needs={needs} running={running} />
        )}
      </header>

      <UpgradesCard model={model} loading={upgradesLoading} />
      <SourcesCard model={model} running={runningSources} />
      <GraphCard model={model} />
      <RepositoryCard model={model} />
      <GeneralCard model={model} />
      <DangerCard model={model} />
    </div>
  )
}

/** The top line: the parts that need the user, then the parts at work. */
function SummaryLine(props: { needs: PartId[]; running: PartId[] }) {
  const { needs, running } = props
  const runningLine = running.length ? (
    <span className="text-muted-foreground">
      {needs.length ? "Running: " : "Nothing needs you. Running: "}
      <PartLinks parts={running} tone="muted" />
    </span>
  ) : null
  if (needs.length === 0 && running.length === 0)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <IconCircleCheck className="size-4 text-teal-300" aria-hidden />
        Everything is up to date.
      </p>
    )
  if (needs.length === 0)
    return (
      <p className="flex items-center gap-2 text-sm">
        <span
          aria-hidden
          className="ctx-status-pulse size-1.5 shrink-0 rounded-full bg-teal-400"
        />
        {runningLine}
      </p>
    )
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <p className="flex items-center gap-2 text-foreground">
        <IconAlertTriangle
          className="size-4 shrink-0 text-amber-300"
          aria-hidden
        />
        <span>
          {needs.length} {needs.length === 1 ? "part needs" : "parts need"} you:{" "}
          <PartLinks parts={needs} tone="attention" />
        </span>
      </p>
      {runningLine ? <p className="pl-6 text-xs">{runningLine}</p> : null}
    </div>
  )
}

function PartLinks(props: { parts: PartId[]; tone: "attention" | "muted" }) {
  return props.parts.map((part, index) => (
    <span key={part}>
      {index > 0 ? (
        <span aria-hidden className="text-muted-foreground">
          {" · "}
        </span>
      ) : null}
      <AriaLink
        onPress={() => jumpTo(part)}
        className={cn(
          "cursor-pointer rounded-md underline underline-offset-2",
          props.tone === "attention"
            ? "text-amber-200 decoration-amber-200/40 hover:decoration-amber-200"
            : "text-muted-foreground decoration-muted-foreground/40 hover:text-foreground",
          focusVisibleClassName,
        )}
      >
        {PART_TITLE[part]}
      </AriaLink>
    </span>
  ))
}

/** One part of the Workspace: its state, settings, and actions. */
function PartCard(props: {
  id: string
  title: string
  description?: ReactNode
  /** A tag or a short muted word, on the right of the title. */
  status?: ReactNode
  needsYou?: boolean
  danger?: boolean
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <section
      id={cardId(props.id)}
      tabIndex={-1}
      aria-labelledby={`${cardId(props.id)}-title`}
      className={cn(
        "scroll-mt-4 rounded-md border border-white/[0.07] bg-zinc-900/30 outline-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-teal-400/60",
        props.needsYou && "border-l-2 border-l-amber-400/70",
        props.danger && "border-red-400/15",
      )}
    >
      <div className="flex items-start justify-between gap-3 px-5 pt-4">
        <div className="min-w-0">
          <h2
            id={`${cardId(props.id)}-title`}
            className="text-sm font-medium text-foreground"
          >
            {props.title}
          </h2>
          {props.description ? (
            <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
              {props.description}
            </p>
          ) : null}
        </div>
        {props.status ? <div className="shrink-0">{props.status}</div> : null}
      </div>
      <div className="px-5 pt-3 pb-4">{props.children}</div>
      {props.footer ? (
        <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-3">
          {props.footer}
        </div>
      ) : null}
    </section>
  )
}

function QuietStatus(props: { children: ReactNode }) {
  return (
    <p className="pt-0.5 text-xs text-muted-foreground">{props.children}</p>
  )
}

// Upgrades

/** The dot of an upgrade row: what kind of attention it wants. */
function upgradeDot(view: UpgradeView): { className: string; label: string } {
  if (view.item.status === "failed")
    return { className: "bg-red-400", label: "Failed" }
  if (view.group === "needs_you")
    return { className: "bg-amber-400", label: "Needs you" }
  return { className: "ctx-status-pulse bg-teal-400", label: "Working" }
}

/** The server title in the words of the page: "file layout", not "format". */
const plainTitle = (title: string) =>
  title.replace(
    /^Upgrade to format (\d+)$/,
    "File layout upgrade to version $1",
  )

/** "14:46" in the user's clock. */
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

function UpgradesCard(props: { model: SettingsModel; loading: boolean }) {
  const { model, loading } = props
  const { upgrades } = model
  const needsYou =
    !loading &&
    (upgrades.status === "error" || upgrades.headline?.label === "Needs you")
  const active = [...upgrades.needsYou, ...upgrades.working]
  // The rows and the alert say "needs you" and "working". The header says
  // only what the body does not.
  const status =
    loading || upgrades.status === "error" || active.length ? null : (
      <QuietStatus>Up to date</QuietStatus>
    )
  // The cost of the last applied re-ingestion: the best guess of the next one.
  const lastCost = [...upgrades.done]
    .filter((view) => view.item.kind === "reingest" && view.spend)
    .sort((a, b) => b.item.updatedAt.localeCompare(a.item.updatedAt))[0]
    ?.spend?.replace(/^Spend: /, "")
  return (
    <PartCard
      id="upgrades"
      title="Upgrades"
      description="ctxpipe keeps this Workspace current."
      status={status}
      needsYou={needsYou}
    >
      {loading ? (
        <div className="flex flex-col gap-1" aria-busy>
          <span className="sr-only">Loading upgrades</span>
          <div className="flex min-h-7 items-center">
            <SkeletonText className="text-xs" boneClassName="w-56" />
          </div>
          <div className="flex min-h-8 items-center">
            <SkeletonText className="text-xs" boneClassName="w-44" />
          </div>
        </div>
      ) : upgrades.status === "error" ? (
        <InlineAlert
          variant="error"
          actions={
            <Button variant="secondary" onPress={upgrades.retry}>
              Try again
            </Button>
          }
        >
          Could not load the upgrades.
        </InlineAlert>
      ) : (
        // Full-width hairlines between the parts, not boxes.
        <div className="-mx-5 -mb-4 divide-y divide-white/[0.06] border-t border-white/[0.06]">
          {active.length ? (
            <ul
              className="divide-y divide-white/[0.06]"
              aria-label="Upgrades that need you or run now"
            >
              {active.map((view) => (
                <UpgradeEntry
                  key={view.key}
                  view={view}
                  model={model}
                  lastCost={view.item.kind === "reingest" ? lastCost : null}
                />
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3 px-5 py-3">
            <AutomaticUpgradesSwitch
              orgSlug={model.orgSlug}
              workspaceSlug={model.workspace.slug}
              isAdmin={model.isAdmin}
            />
            <FormatNote line={upgrades.formatLine} />
          </div>
          {upgrades.done.length ? (
            <HistorySection views={upgrades.done} />
          ) : null}
        </div>
      )}
    </PartCard>
  )
}

/** One upgrade that needs the user or runs now: a row, with its action on the right. */
function UpgradeEntry(props: {
  view: UpgradeView
  model: SettingsModel
  lastCost: string | null | undefined
}) {
  const { view, model } = props
  const stepsWithReport = view.steps.filter((step) => step.report.length > 0)
  const failure = view.failure
  const dot = upgradeDot(view)
  const waitsToStart =
    view.item.kind === "reingest" && view.item.status === "awaiting_operator"
  // One muted line of facts. "Ready to start" is the Start button itself.
  const meta = [
    waitsToStart ? null : view.tag.label,
    waitsToStart && props.lastCost
      ? `The last run cost ${props.lastCost}`
      : null,
    waitsToStart && view.item.checkedAt
      ? `Checked at ${clock(view.item.checkedAt)}`
      : view.checkResult,
    view.blocked ? null : view.note,
    view.waiting,
    view.spend,
  ].filter((line): line is string => Boolean(line))
  return (
    <li className="px-5 py-4" aria-label={view.title}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm text-foreground">
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", dot.className)}
            />
            <span className="sr-only">{dot.label}: </span>
            {plainTitle(view.title)}
          </h3>
          <p className="mt-1 max-w-prose pl-3.5 text-xs text-muted-foreground">
            {view.description}
          </p>
          {meta.length ? (
            <p className="mt-1.5 pl-3.5 text-xs text-muted-foreground">
              {meta.join(" · ")}
            </p>
          ) : null}
          {view.pullRequest ? (
            <p className="mt-1.5 pl-3.5">
              <TextLink
                href={view.pullRequest.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs"
              >
                <IconGitPullRequest className="size-3.5" aria-hidden />
                {view.pullRequest.number
                  ? `Open pull request #${view.pullRequest.number}`
                  : "Open pull request"}
              </TextLink>
            </p>
          ) : null}
        </div>
        <div className="shrink-0">
          <UpgradeAction view={view} />
        </div>
      </div>

      <div className="pl-3.5">
        {view.steps.length ? (
          <ol
            className="mt-3 flex flex-col gap-1"
            aria-label={`Steps of ${view.title}`}
          >
            {view.steps.map((step, index) => (
              <li
                key={step.format}
                className="flex items-baseline gap-2 text-xs text-muted-foreground"
              >
                <span className="w-3 shrink-0 tabular-nums">{index + 1}</span>
                <span>{step.title}</span>
                {step.commitSha ? (
                  <code className="font-mono">
                    {step.commitSha.slice(0, 7)}
                  </code>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}

        {view.progress ? (
          <UpgradeRunProgress title={view.title} progress={view.progress} />
        ) : null}

        {view.notices.length ? (
          <ul
            className="mt-3 flex flex-col gap-1.5 text-xs"
            aria-label={`Notes of ${view.title}`}
          >
            {view.notices.map((notice) => (
              <li
                key={`${notice.kind}-${notice.text}`}
                className="flex items-start gap-2"
              >
                {notice.kind === "action" ? (
                  <IconArrowRight
                    className="mt-px size-3.5 shrink-0 text-foreground"
                    aria-hidden
                  />
                ) : (
                  <IconAlertTriangle
                    className="mt-px size-3.5 shrink-0 text-amber-300"
                    aria-hidden
                  />
                )}
                <span
                  className={
                    notice.kind === "action"
                      ? "text-foreground"
                      : "text-muted-foreground"
                  }
                >
                  <span className="sr-only">
                    {notice.kind === "action" ? "Action: " : "Risk: "}
                  </span>
                  {notice.text}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {stepsWithReport.length ? (
          <Disclosure className="-mx-2 mt-2">
            <DisclosureHeader>
              <span className="text-xs font-normal text-muted-foreground">
                Details
              </span>
            </DisclosureHeader>
            <DisclosurePanel className="px-2">
              <div className="flex flex-col gap-2 pb-1">
                {stepsWithReport.map((step) => (
                  <div key={step.format}>
                    <p className="text-xs text-foreground">
                      Format {step.format}: {step.title}
                    </p>
                    <ul className="mt-1 flex flex-col gap-1 text-xs break-words text-muted-foreground">
                      {step.report.map((line) => (
                        <li key={`${step.format}-${line}`}>{line}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </DisclosurePanel>
          </Disclosure>
        ) : null}

        {view.blocked ? (
          <div className="mt-3">
            <InlineAlert variant="warning" title={view.blocked.title}>
              <p>{view.blocked.body}</p>
            </InlineAlert>
          </div>
        ) : null}

        {failure ? (
          <div className="mt-3">
            <InlineAlert
              variant="error"
              title="The upgrade failed"
              actions={
                failure.connectorsHref || failure.fixPrompt ? (
                  <>
                    {failure.connectorsHref ? (
                      <TextLink
                        href={failure.connectorsHref}
                        className="self-center text-xs"
                      >
                        {failure.connectorsLabel}
                      </TextLink>
                    ) : null}
                    {failure.fixPrompt && model.graph.fixWithAgent ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onPress={() =>
                          failure.fixPrompt &&
                          model.graph.fixWithAgent?.(failure.fixPrompt)
                        }
                      >
                        Fix using agent
                      </Button>
                    ) : null}
                  </>
                ) : undefined
              }
            >
              {failure.step ? <p>Failed step: {failure.step}.</p> : null}
              <p className={failure.step ? "mt-1" : undefined}>
                {failure.reason}
              </p>
              <p className="mt-1 text-xs break-words opacity-80">
                Details: {failure.summary}
              </p>
              <p className="mt-1">{failure.action}</p>
              {failure.autoRetried ? (
                <p className="mt-1">
                  ctxpipe already started this upgrade again once by itself.
                </p>
              ) : null}
            </InlineAlert>
          </div>
        ) : view.failureReason ? (
          <div className="mt-3">
            <InlineAlert variant="error" title="The upgrade failed">
              <p>{view.failureReason}</p>
            </InlineAlert>
          </div>
        ) : null}
      </div>
    </li>
  )
}

/** The one action of an upgrade row, small and on the right of its title. */
function UpgradeAction(props: { view: UpgradeView }) {
  const { view } = props
  if (view.canCheck)
    return (
      <Button
        variant="secondary"
        size="sm"
        isPending={view.checking}
        onPress={view.check}
        aria-label={`Check again: ${view.title}`}
      >
        Check again
      </Button>
    )
  if (view.canStart)
    return (
      <Button
        variant="primary"
        size="sm"
        isPending={view.starting}
        onPress={view.start}
        aria-label={`${view.startLabel}: ${view.title}`}
      >
        {view.startLabel}
      </Button>
    )
  if (view.memberAsk)
    return (
      <p className="pt-1 text-xs text-muted-foreground">{view.memberAsk}</p>
    )
  return null
}

/**
 * The automatic-upgrades setting as a switch. The same save as
 * AutomaticUpgradesToggle: a commit to the format file, then the new setting.
 * The switch shows the new position while the commit runs.
 */
function AutomaticUpgradesSwitch(props: {
  orgSlug: string
  workspaceSlug: string
  isAdmin: boolean | null
}) {
  const { orgSlug, workspaceSlug } = props
  const queryClient = useQueryClient()
  const modeOptions = workspaceUpgradeModeOptions(orgSlug, workspaceSlug)
  const setting = useQuery(modeOptions).data
  const save = useMutation({
    mutationFn: (next: "manual" | "automatic") =>
      saveWorkspaceUpgradeModeAndWait(
        queryClient,
        orgSlug,
        workspaceSlug,
        next,
      ),
    onSuccess: (result, next) => {
      if (result === "pending") {
        toast.message(
          "ctxpipe has not finished the save yet. Refresh the page later to see the setting.",
        )
        return
      }
      queryClient.setQueryData(modeOptions.queryKey, {
        mode: next,
        reason: null,
      })
    },
    onError: (error: Error) => {
      toast.error(`${error.message.replace(/\.$/, "")}. Try again.`)
    },
    onSettled: (_result, _error, next) => {
      if (next === "automatic")
        void queryClient.invalidateQueries({
          queryKey: workspaceUpgradeKeys.list(orgSlug, workspaceSlug),
        })
    },
  })
  if (!setting) return null
  if (setting.mode === null)
    return (
      <p className="max-w-prose text-xs text-muted-foreground">
        Automatic upgrades: ctxpipe could not read the setting. Check the GitHub
        connection on the Connectors page, then reload this page.
      </p>
    )
  const on = save.isPending
    ? save.variables === "automatic"
    : setting.mode === "automatic"
  const canChange = props.isAdmin === true
  const helpId = `automatic-upgrades-help-${workspaceSlug}`
  return (
    <div className="flex min-w-0 basis-[30rem] flex-col gap-1">
      <AriaSwitch
        isSelected={on}
        isDisabled={!canChange || save.isPending}
        onChange={(next) => save.mutate(next ? "automatic" : "manual")}
        aria-describedby={helpId}
        className="group flex w-fit items-center gap-2.5 text-sm text-foreground disabled:cursor-default"
      >
        {({ isSelected, isFocusVisible }) => (
          <>
            <span
              aria-hidden
              className={cn(
                "flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors",
                isSelected ? "bg-teal-500" : "bg-white/15",
                isFocusVisible &&
                  "ring-2 ring-ring ring-offset-2 ring-offset-background",
                !canChange && "opacity-50",
              )}
            >
              <span
                className={cn(
                  "size-3 rounded-full bg-white shadow transition-transform",
                  isSelected && "translate-x-3",
                )}
              />
            </span>
            Automatic upgrades
            {save.isPending ? (
              <span className="text-xs text-muted-foreground">Saving…</span>
            ) : null}
          </>
        )}
      </AriaSwitch>
      <p id={helpId} className="pl-9.5 text-xs text-muted-foreground">
        {on
          ? "ctxpipe starts each upgrade by itself, paid re-ingestions too. A failed upgrade waits for you."
          : canChange
            ? "You start each upgrade. Turn this on to let ctxpipe start them."
            : "An owner or admin starts each upgrade, and can turn this on."}
      </p>
    </div>
  )
}

/**
 * The Workspace format in plain words, with a tooltip that says what it is.
 * A format problem (not readable, newer than ctxpipe) shows as its sentence.
 */
function FormatNote(props: { line: string | null }) {
  const latest = props.line?.match(/^Format (\d+)$/)
  const behind = props.line?.match(
    /^The repository uses format (\d+)\. ctxpipe reads format (\d+)\.$/,
  )
  const version = latest?.[1] ?? behind?.[1]
  if (!version)
    return props.line ? (
      <p className="max-w-prose text-xs text-muted-foreground">{props.line}</p>
    ) : null
  return (
    <p className="flex items-center gap-1 text-xs text-muted-foreground">
      {behind
        ? `File layout: version ${version}. The latest is ${behind[2]}.`
        : `File layout: version ${version}, the latest`}
      <TooltipTrigger delay={200}>
        <AriaButton
          aria-label="About the file layout version"
          className={cn(
            "rounded-full p-0.5 text-muted-foreground hover:text-foreground",
            focusVisibleClassName,
          )}
        >
          <IconInfoCircle className="size-3.5" aria-hidden />
        </AriaButton>
        <Tooltip
          placement="top end"
          offset={6}
          className="max-w-64 rounded-md bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-100 shadow-md"
        >
          How ctxpipe arranges the files in this Workspace's repository. When a
          new layout ships, an upgrade moves the files in a pull request.
        </Tooltip>
      </TooltipTrigger>
    </p>
  )
}

const HISTORY_SHOWN = 5

/**
 * The applied upgrades, newest first: a date, what it was, and its pull
 * request or spend. Five show; the rest open in a scroll area.
 */
function HistorySection(props: { views: UpgradeView[] }) {
  const [all, setAll] = useState(false)
  const sorted = [...props.views].sort((a, b) =>
    b.item.updatedAt.localeCompare(a.item.updatedAt),
  )
  const shown = all ? sorted : sorted.slice(0, HISTORY_SHOWN)
  const last = sorted[0]
  return (
    <Disclosure className="px-3 py-1">
      <DisclosureHeader>
        <span className="flex w-full items-baseline gap-2 text-xs font-normal">
          <span className="text-foreground">History</span>
          <span className="text-muted-foreground">
            {sorted.length} applied
            {last ? ` · last on ${historyDate(last.item.updatedAt)}` : ""}
          </span>
        </span>
      </DisclosureHeader>
      <DisclosurePanel className="px-2 pb-2">
        <ul
          className={cn(
            "divide-y divide-white/[0.04]",
            all &&
              sorted.length > HISTORY_SHOWN &&
              "max-h-72 overflow-y-auto pr-1",
          )}
          aria-label="Applied upgrades"
        >
          {shown.map((view) => (
            <HistoryRow key={view.key} view={view} />
          ))}
        </ul>
        {sorted.length > HISTORY_SHOWN ? (
          <Button
            variant="quiet"
            size="sm"
            className="mt-1 -ml-2.5"
            onPress={() => setAll((value) => !value)}
          >
            {all ? "Show fewer" : `Show all ${sorted.length}`}
          </Button>
        ) : null}
      </DisclosurePanel>
    </Disclosure>
  )
}

/** "Oct 21", in one zone, as the history line of the current page. */
const historyDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })

function HistoryRow(props: { view: UpgradeView }) {
  const { view } = props
  return (
    <li className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-baseline gap-x-3 py-2 text-xs">
      <span className="text-muted-foreground tabular-nums">
        {historyDate(view.item.updatedAt)}
      </span>
      <span className="truncate text-foreground">{plainTitle(view.title)}</span>
      <span className="text-muted-foreground">
        {view.pullRequest ? (
          <TextLink
            href={view.pullRequest.url}
            target="_blank"
            rel="noreferrer"
            variant="secondary"
            className="inline-flex items-center gap-1 text-xs"
          >
            <IconGitPullRequest className="size-3.5" aria-hidden />
            {view.pullRequest.number
              ? `#${view.pullRequest.number}`
              : "Pull request"}
          </TextLink>
        ) : view.spend ? (
          view.spend.replace(/^Spend: /, "")
        ) : null}
      </span>
    </li>
  )
}

// Sources

/** The short word for the work of a source, for the Status column. */
function liveLabel(source: SourceActivity): string {
  if (source.kind === "source_sync") return "Syncing"
  if (source.kind === "reingest") return "Re-ingesting"
  switch (source.lead.stage) {
    case "publishing":
      return "Publishing"
    case "ingesting":
      return "Reading the code"
    case "indexing":
      return "Indexing for search"
    case "planning":
      return "Planning"
    case "waiting":
      return "Waiting for a turn"
    case "queued":
      return "Queued"
    default:
      return "Working"
  }
}

function SourcesCard(props: {
  model: SettingsModel
  running: SourceActivity[]
}) {
  const { model, running } = props
  const { activity } = model
  const toLive = (
    source: SourceActivity | undefined,
  ): SourceLiveStatus | null =>
    source
      ? {
          label: liveLabel(source),
          since: source.since,
          runs: source.runs.map((run) => {
            const progress = ingestionProgress(run)
            return {
              key: run.id,
              label: progress.count
                ? `${progress.label} · ${progress.count}`
                : progress.label,
              since: run.startedAt,
            }
          }),
        }
      : null
  // A repository run is named by the repository; a connector sync by the
  // provider ("Linear sources").
  const liveStatus: SourceLiveStatusLookup = {
    repository: (title) =>
      toLive(
        running.find(
          (source) =>
            source.kind === "repository" &&
            source.title.toLowerCase() === title.toLowerCase(),
        ),
      ),
    provider: (label) =>
      toLive(
        running.find(
          (source) =>
            source.kind === "source_sync" &&
            source.title === `${label} sources`,
        ),
      ),
  }
  return (
    <PartCard id="sources" title="Sources">
      {activity.status === "error" ? (
        <div className="mb-4">
          <InlineAlert
            variant="warning"
            actions={
              <Button variant="secondary" onPress={activity.retry}>
                Try again
              </Button>
            }
          >
            Could not load what the sources do now. The list still shows each
            source and its connection.
          </InlineAlert>
        </div>
      ) : null}
      <WorkspaceSources
        orgSlug={model.orgSlug}
        workspaceSlug={model.workspace.slug}
        linkedRepositories={model.repository.linkedRepositories}
        {...(activity.status === "ready" ? { liveStatus } : {})}
      />
      {running.length ? (
        <p className="mt-3 text-xs text-muted-foreground">
          You can leave this page. The work continues.
        </p>
      ) : null}
    </PartCard>
  )
}

// Knowledge graph

function GraphCard(props: { model: SettingsModel }) {
  const { graph, workspace } = props.model
  const skipped = graph.skippedFiles
  const failed = graph.status === "failed"
  const indexing = graph.indexingRun
  const now = useNow(indexing !== null)
  const legacy = new Set(
    (workspace.skippedFiles ?? [])
      .filter((file) => file.source === "legacy-overlay")
      .map((file) => file.path),
  )
  return (
    <PartCard
      id="graph"
      title="Knowledge graph"
      needsYou={failed || skipped.length > 0}
    >
      <div className="flex flex-col gap-3">
        {failed ? (
          <InlineAlert variant="error" title="The knowledge graph did not load">
            {graph.error ?? "ctxpipe gives no reason."}
          </InlineAlert>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                graph.status === "ready"
                  ? "bg-teal-400"
                  : "ctx-status-pulse bg-zinc-400",
              )}
            />
            {graph.status === "ready"
              ? "The knowledge graph is loaded."
              : graph.status === "running"
                ? "ctxpipe loads the knowledge graph now."
                : "The knowledge graph waits to load."}
          </p>
        )}
        {indexing ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span
              aria-hidden
              className="ctx-status-pulse size-1.5 shrink-0 rounded-full bg-teal-400"
            />
            Indexing the newest commit…
            <span className="text-xs tabular-nums">
              {formatElapsed(indexing.startedAt, now)}
            </span>
          </p>
        ) : null}
        {graph.projectionLag ? (
          <p className="text-sm text-muted-foreground">
            Answers still come from{" "}
            <code className="font-mono text-xs text-foreground">
              {graph.projectionLag}
            </code>{" "}
            until the new repository finishes loading.
          </p>
        ) : null}
        {skipped.length ? (
          <div className="mt-1 border-t border-white/[0.06] pt-3">
            <h3 className="text-sm text-foreground">
              ctxpipe skipped {skipped.length}{" "}
              {skipped.length === 1 ? "file" : "files"}
            </h3>
            <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
              Chat, MCP, search, and the graph do not use these files.
              {skipped.some((file) => !legacy.has(file.path))
                ? " Fix each file that is in Git and push the change to the default branch."
                : ""}
            </p>
            <ul className="mt-2 flex flex-col divide-y divide-white/[0.06]">
              {skipped.map((file) => (
                <li
                  key={file.path}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-foreground">
                      {file.path}
                    </p>
                    <p className="text-xs text-muted-foreground">{file.text}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {legacy.has(file.path) ? null : (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Open ${file.path}`}
                        onPress={() => graph.openFile(file.path)}
                      >
                        Open
                      </Button>
                    )}
                    {file.fixPrompt && graph.fixWithAgent ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={`Fix ${file.path} using agent`}
                        onPress={() =>
                          file.fixPrompt && graph.fixWithAgent?.(file.fixPrompt)
                        }
                      >
                        Fix using agent
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </PartCard>
  )
}

// Repository

function RepositoryCard(props: { model: SettingsModel }) {
  const { repository, access } = props.model
  const canSave =
    repository.rootFolderChanged && repository.rootFolderError === null
  return (
    <PartCard
      id="repository"
      title="Repository"
      description="The GitHub repository where this Workspace keeps its files."
      needsYou={
        access.tone === "read_only" ||
        access.tone === "check_failed" ||
        access.stalled
      }
      footer={
        <Button
          type="submit"
          form="settings-d-root-folder"
          variant="primary"
          isPending={repository.savingRootFolder}
          isDisabled={!canSave}
        >
          Save
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span
            className="ctx-node size-8 shrink-0 rounded-md text-muted-foreground"
            aria-hidden
          >
            <IconGitBranch className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-foreground">
              {repository.title}
            </p>
            {repository.webUrl ? (
              <a
                href={repository.webUrl}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  "block truncate rounded-md text-xs text-muted-foreground hover:text-foreground",
                  focusVisibleClassName,
                )}
              >
                {repository.url}
              </a>
            ) : (
              <p className="truncate font-mono text-xs text-muted-foreground">
                {repository.url}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onPress={repository.openRelink}
          >
            Change
          </Button>
        </div>

        <WriteAccessLine model={props.model} />

        <form
          id="settings-d-root-folder"
          className="max-w-md"
          onSubmit={(event) => {
            event.preventDefault()
            repository.saveRootFolder()
          }}
        >
          <TextField
            label="Root folder"
            placeholder="Leave empty to use the whole repository"
            value={repository.rootFolder}
            onChange={repository.setRootFolder}
            isDisabled={repository.savingRootFolder}
            isInvalid={repository.rootFolderError !== null}
            errorMessage={repository.rootFolderError ?? undefined}
            description="ctxpipe reads and changes files only in this folder."
          />
        </form>
      </div>
    </PartCard>
  )
}

/** Write access as plain text, with the fix next to it. */
function WriteAccessLine(props: { model: SettingsModel }) {
  const { access, repository } = props.model
  const problem =
    access.tone === "read_only" ||
    access.tone === "check_failed" ||
    access.stalled
  const text =
    access.tone === "writable"
      ? "ctxpipe can push to this repository."
      : access.tone === "pull_request"
        ? `Changes by pull request. ${access.description}`
        : access.tone === "pending"
          ? access.stalled
            ? "ctxpipe still checks write access. The check takes longer than usual."
            : "ctxpipe checks write access now."
          : access.description
  const fix =
    access.tone === "read_only" && access.needsRelink ? (
      <Button variant="secondary" size="sm" onPress={repository.openRelink}>
        Select the repository again
      </Button>
    ) : problem ? (
      <Button
        variant="secondary"
        size="sm"
        isPending={access.checking}
        onPress={access.checkAgain}
      >
        Check again
      </Button>
    ) : null
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-md px-3 py-2.5",
        problem ? "bg-amber-400/[0.06]" : "bg-white/[0.03]",
      )}
    >
      <div className="flex min-w-0 flex-1 basis-64 items-start gap-2">
        {problem ? (
          <IconAlertTriangle
            className="mt-0.5 size-4 shrink-0 text-amber-300"
            aria-hidden
          />
        ) : access.tone === "pull_request" ? (
          <IconGitPullRequest
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
        ) : (
          <IconCircleCheck
            className="mt-0.5 size-4 shrink-0 text-teal-300"
            aria-hidden
          />
        )}
        <p
          className={cn(
            "text-sm",
            problem ? "text-amber-50" : "text-muted-foreground",
          )}
        >
          <span className="sr-only">Write access: </span>
          {text}
          {access.tone === "read_only" ? (
            <span className="text-amber-100/70">
              {" "}
              {access.needsRelink
                ? "After GitHub can see the repository, select it again."
                : "After you fix it, press Check again."}
            </span>
          ) : null}
        </p>
      </div>
      {fix}
    </div>
  )
}

// Workspace

function GeneralCard(props: { model: SettingsModel }) {
  const { general } = props.model
  return (
    <PartCard
      id="general"
      title="Workspace"
      status={general.dirty ? <QuietStatus>Not saved</QuietStatus> : null}
      footer={
        <>
          {general.dirty ? (
            <Button
              variant="ghost"
              isDisabled={general.saving}
              onPress={general.reset}
            >
              Reset
            </Button>
          ) : null}
          <Button
            type="submit"
            form="settings-c-general"
            variant="primary"
            isPending={general.saving}
            isDisabled={!general.dirty}
          >
            Save
          </Button>
        </>
      }
    >
      <form
        id="settings-c-general"
        className="grid items-start gap-4 @2xl:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (general.dirty) general.save()
        }}
      >
        <TextField
          label="Name"
          value={general.displayName}
          onChange={general.setDisplayName}
          description="Shown in the sidebar and to your team."
        />
        <TextField
          label="URL name"
          value={general.slug}
          onChange={general.setSlug}
          description="If you change the URL name, old links stop working."
        />
      </form>
    </PartCard>
  )
}

// Danger zone

function DangerCard(props: { model: SettingsModel }) {
  return (
    <PartCard id="danger" title="Danger zone" danger>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-sm text-foreground">Delete this Workspace</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Deletes this Workspace and its conversations. Your GitHub repository
            and its files stay.
          </p>
        </div>
        <Button
          variant="outline"
          className="shrink-0"
          onPress={props.model.openDelete}
        >
          Delete Workspace
        </Button>
      </div>
    </PartCard>
  )
}
