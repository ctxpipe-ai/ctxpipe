/**
 * PROTOTYPE, throwaway (see prototype-variant.ts). Variant C, "One card for
 * each part": each part of the Workspace is one card that holds its state,
 * its settings, and its actions. A card that needs the user gets an amber
 * left edge and a tag. A short line at the top links to those cards.
 */
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCircleCheck,
  IconGitBranch,
  IconGitPullRequest,
} from "@tabler/icons-react"
import type { ReactNode } from "react"
import { Link as AriaLink, ProgressBar } from "react-aria-components"

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
import { WorkspaceSources } from "@/features/workspace-sources/WorkspaceSources"
import { AutomaticUpgradesToggle } from "@/features/workspace-upgrades/AutomaticUpgradesToggle"
import { formatElapsed } from "@/features/workspace-upgrades/upgrade-progress"
import { UpgradeRunProgress } from "@/features/workspace-upgrades/UpgradeRunProgress"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { useNow } from "@/lib/useNow"
import { cn } from "@/lib/utils"

import { StatusTag } from "../StatusTag"
import type {
  SettingsModel,
  SourceActivity,
  UpgradeView,
} from "./use-settings-model"

const TONE = {
  attention: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  good: "border-teal-400/30 bg-teal-400/10 text-teal-200",
  neutral: "border-border bg-zinc-800 text-muted-foreground",
  error: "border-red-400/30 bg-red-400/10 text-red-200",
}

type PartId = "upgrades" | "sources" | "graph" | "repository"

const PART_TITLE: Record<PartId, string> = {
  upgrades: "Upgrades",
  sources: "Sources",
  graph: "Knowledge graph",
  repository: "Repository",
}

const cardId = (part: string) => `settings-card-${part}`

/** Moves the view and the focus to a card. */
function jumpTo(part: PartId) {
  const card = document.getElementById(cardId(part))
  if (!card) return
  card.scrollIntoView({ block: "start" })
  card.focus({ preventScroll: true })
}

export function VariantC(props: { model: SettingsModel }) {
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
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-4">
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

function UpgradesCard(props: { model: SettingsModel; loading: boolean }) {
  const { model, loading } = props
  const { upgrades } = model
  const needsYou =
    !loading &&
    (upgrades.status === "error" || upgrades.headline?.label === "Needs you")
  const status = loading ? null : upgrades.status === "error" ? (
    <StatusTag label="Could not load" className={TONE.attention} />
  ) : upgrades.headline?.label === "Needs you" ? (
    <StatusTag label="Needs you" className={TONE.attention} />
  ) : upgrades.working.length ? (
    <StatusTag label="Working" className={TONE.good} pulse />
  ) : (
    <QuietStatus>Up to date</QuietStatus>
  )
  const active = [...upgrades.needsYou, ...upgrades.working]
  return (
    <PartCard
      id="upgrades"
      title="Upgrades"
      description={
        upgrades.intro ?? "ctxpipe keeps the format of this Workspace current."
      }
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
        <div className="flex flex-col gap-3">
          {active.length ? (
            <ul
              className="mt-1 flex flex-col divide-y divide-white/[0.06]"
              aria-label="Upgrades that need you or run now"
            >
              {active.map((view) => (
                <UpgradeEntry key={view.key} view={view} model={model} />
              ))}
            </ul>
          ) : null}
          <div
            className={cn(
              "flex min-h-7 flex-wrap items-center gap-x-2 text-xs text-muted-foreground",
              active.length && "border-t border-white/[0.06] pt-3",
            )}
          >
            <span>{upgrades.formatLine}</span>
            <AutomaticUpgradesToggle
              orgSlug={model.orgSlug}
              workspaceSlug={model.workspace.slug}
              isAdmin={model.isAdmin}
            />
          </div>
          {upgrades.done.length && upgrades.historyLine ? (
            <Disclosure className="-mx-2 -mt-2">
              <DisclosureHeader>
                <span className="text-xs font-normal text-muted-foreground">
                  {upgrades.historyLine}
                </span>
              </DisclosureHeader>
              <DisclosurePanel className="px-2">
                <ul
                  className="flex flex-col divide-y divide-white/[0.06] pb-1"
                  aria-label="Applied upgrades"
                >
                  {upgrades.done.map((view) => (
                    <HistoryRow key={view.key} view={view} />
                  ))}
                </ul>
              </DisclosurePanel>
            </Disclosure>
          ) : null}
        </div>
      )}
    </PartCard>
  )
}

/** One upgrade that needs the user or runs now, with its one action. */
function UpgradeEntry(props: { view: UpgradeView; model: SettingsModel }) {
  const { view, model } = props
  const stepsWithReport = view.steps.filter((step) => step.report.length > 0)
  const failure = view.failure
  return (
    <li className="py-4 first:pt-0 last:pb-1" aria-label={view.title}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <h3 className="min-w-0 text-sm text-foreground">{view.title}</h3>
        <StatusTag {...view.tag} />
      </div>
      <p className="mt-1 max-w-prose text-xs text-muted-foreground">
        {view.description}
      </p>

      {view.steps.length ? (
        <ol
          className="mt-3 flex flex-col gap-1.5"
          aria-label={`Steps of ${view.title}`}
        >
          {view.steps.map((step, index) => (
            <li key={step.format} className="flex items-baseline gap-2 text-xs">
              <span className="w-4 shrink-0 text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <span className="text-foreground">{step.title}</span>
              {step.commitSha ? (
                <code className="font-mono text-muted-foreground">
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

      {[
        view.blocked ? null : view.note,
        view.waiting,
        view.checkResult,
        view.spend ? `${view.spend}.` : null,
      ]
        .filter((line): line is string => Boolean(line))
        .map((line) => (
          <p key={line} className="mt-2 text-xs text-muted-foreground">
            {line}
          </p>
        ))}

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

      <UpgradeActions view={view} />
    </li>
  )
}

function UpgradeActions(props: { view: UpgradeView }) {
  const { view } = props
  const action = view.canCheck ? (
    <Button
      variant="secondary"
      isPending={view.checking}
      onPress={view.check}
      aria-label={`Check again: ${view.title}`}
    >
      Check again
    </Button>
  ) : view.canStart ? (
    <Button
      variant="primary"
      isPending={view.starting}
      onPress={view.start}
      aria-label={`${view.startLabel}: ${view.title}`}
    >
      {view.startLabel}
    </Button>
  ) : view.memberAsk ? (
    <p className="text-xs text-muted-foreground">{view.memberAsk}</p>
  ) : null
  if (!view.pullRequest && !action) return null
  return (
    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
      {view.pullRequest ? (
        <Button
          variant="secondary"
          href={view.pullRequest.url}
          target="_blank"
          rel="noreferrer"
        >
          <IconGitPullRequest className="size-4" aria-hidden />
          {view.pullRequest.number
            ? `Open pull request #${view.pullRequest.number}`
            : "Open pull request"}
        </Button>
      ) : null}
      {action}
    </div>
  )
}

function HistoryRow(props: { view: UpgradeView }) {
  const { view } = props
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5">
      <div className="min-w-0">
        <p className="text-xs text-foreground">{view.title}</p>
        {view.spend ? (
          <p className="text-xs text-muted-foreground">{view.spend}.</p>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
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
        ) : null}
        <StatusTag {...view.tag} />
      </div>
    </li>
  )
}

// Sources

const STAGE_WORD: Record<string, string> = {
  publishing: "publishing",
  ingesting: "reading the code",
  indexing: "indexing",
  planning: "planning",
  waiting: "waiting",
  queued: "queued",
}
const STAGE_ORDER = Object.keys(STAGE_WORD)

/** "6 runs: 1 publishing, 4 reading the code, 1 waiting". */
function runsLine(source: SourceActivity): string | null {
  if (source.runs.length < 2) return null
  const counts = new Map<string, number>()
  for (const run of source.runs) {
    const stage = run.stage ?? "running"
    counts.set(stage, (counts.get(stage) ?? 0) + 1)
  }
  const parts = [...counts]
    .sort(
      ([a], [b]) =>
        (STAGE_ORDER.indexOf(a) + 1 || 99) - (STAGE_ORDER.indexOf(b) + 1 || 99),
    )
    .map(([stage, count]) => `${count} ${STAGE_WORD[stage] ?? stage}`)
  return `${source.runs.length} runs: ${parts.join(", ")}`
}

function SourcesCard(props: {
  model: SettingsModel
  running: SourceActivity[]
}) {
  const { model, running } = props
  const { activity } = model
  const loading = useSkeletonHold(activity.status === "loading")
  const now = useNow(running.length > 0)
  return (
    <PartCard
      id="sources"
      title="Sources"
      status={
        running.length ? (
          <StatusTag label="Working" className={TONE.good} pulse />
        ) : null
      }
    >
      {loading ? (
        <div className="mb-5">
          <SkeletonText className="text-sm" boneClassName="w-48" />
        </div>
      ) : activity.status === "error" ? (
        <div className="mb-5">
          <InlineAlert
            variant="error"
            actions={
              <Button variant="secondary" onPress={activity.retry}>
                Try again
              </Button>
            }
          >
            Could not load the ingestion state.
          </InlineAlert>
        </div>
      ) : running.length ? (
        <div className="mb-5 flex flex-col gap-2">
          <ul
            className="flex flex-col gap-3 rounded-md bg-white/[0.03] px-3 py-3"
            aria-label="Running now"
          >
            {running.map((source) => (
              <li key={source.key} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 truncate font-mono text-sm text-foreground">
                    {source.title}
                  </p>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatElapsed(source.since, now)}
                  </span>
                </div>
                <ProgressBar
                  aria-label={`Progress of ${source.title}`}
                  {...(source.progress.fraction === null
                    ? { isIndeterminate: true }
                    : { value: source.progress.fraction * 100 })}
                  className="h-0.5 w-full overflow-hidden rounded-full bg-zinc-800"
                >
                  {source.progress.fraction === null ? (
                    <div className="ctx-loading-motion h-full w-full animate-pulse rounded-full bg-teal-400/50" />
                  ) : (
                    <div
                      className="h-full w-full origin-left rounded-full bg-teal-400 transition-[scale]"
                      style={{ scale: `${source.progress.fraction} 1` }}
                    />
                  )}
                </ProgressBar>
                <p className="text-xs text-muted-foreground">
                  {source.progress.label}
                  {source.progress.count ? ` · ${source.progress.count}` : ""}
                  {runsLine(source) ? ` · ${runsLine(source)}` : ""}
                </p>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            You can leave this page. The work continues.
          </p>
        </div>
      ) : null}
      <WorkspaceSources
        orgSlug={model.orgSlug}
        workspaceSlug={model.workspace.slug}
        linkedRepositories={model.repository.linkedRepositories}
      />
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
  const status = failed ? (
    <StatusTag label="Did not load" className={TONE.error} />
  ) : skipped.length ? (
    <StatusTag
      label={`${skipped.length} ${skipped.length === 1 ? "file" : "files"} skipped`}
      className={TONE.attention}
    />
  ) : graph.status === "running" ? (
    <StatusTag label="Loading" className={TONE.neutral} pulse />
  ) : indexing ? (
    <StatusTag label="Indexing" className={TONE.neutral} pulse />
  ) : graph.status === "ready" ? (
    <QuietStatus>Loaded</QuietStatus>
  ) : (
    <StatusTag label="Waiting to load" className={TONE.neutral} pulse />
  )
  const legacy = new Set(
    (workspace.skippedFiles ?? [])
      .filter((file) => file.source === "legacy-overlay")
      .map((file) => file.path),
  )
  return (
    <PartCard
      id="graph"
      title="Knowledge graph"
      status={status}
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
  const status =
    access.tone === "read_only" ? (
      <StatusTag label="Read-only" className={TONE.attention} />
    ) : access.tone === "check_failed" ? (
      <StatusTag label="Could not check access" className={TONE.attention} />
    ) : access.stalled ? (
      <StatusTag label="Still checking access" className={TONE.attention} />
    ) : access.tone === "pending" ? (
      <StatusTag label="Checking access" className={TONE.neutral} pulse />
    ) : null
  const canSave =
    repository.rootFolderChanged && repository.rootFolderError === null
  return (
    <PartCard
      id="repository"
      title="Repository"
      description="The GitHub repository where this Workspace keeps its files."
      status={status}
      needsYou={
        access.tone === "read_only" ||
        access.tone === "check_failed" ||
        access.stalled
      }
      footer={
        <Button
          type="submit"
          form="settings-c-root-folder"
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
          id="settings-c-root-folder"
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
      status={
        general.dirty ? (
          <StatusTag label="Not saved" className={TONE.neutral} />
        ) : null
      }
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
