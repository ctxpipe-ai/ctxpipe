/**
 * PROTOTYPE, throwaway (see prototype-variant.ts). Variant A, "Overview and
 * settings tabs". One state line tells what the Workspace needs, with at most
 * one primary action. Under it, Overview shows what the Workspace does, and
 * Settings shows how it is configured. Each settings section has its own save.
 */
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowRight,
  IconCoin,
  IconGitBranch,
  IconGitPullRequest,
} from "@tabler/icons-react"
import type { ReactNode } from "react"
import { Link as AriaLink } from "react-aria-components"

import { Button } from "@/components/ui/Button"
import {
  Disclosure,
  DisclosureHeader,
  DisclosurePanel,
} from "@/components/ui/Disclosure"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Link } from "@/components/ui/Link"
import {
  Skeleton,
  SkeletonText,
  useSkeletonHold,
} from "@/components/ui/Skeleton"
import { Tab, TabList, TabPanel, Tabs } from "@/components/ui/Tabs"
import { TextField } from "@/components/ui/TextField"
import { githubRepoFullNameFromGitUrl } from "@/features/repositories/github-web-url"
import { WorkspaceSources } from "@/features/workspace-sources/WorkspaceSources"
import { AutomaticUpgradesToggle } from "@/features/workspace-upgrades/AutomaticUpgradesToggle"
import { formatElapsed } from "@/features/workspace-upgrades/upgrade-progress"
import { UpgradeRunProgress } from "@/features/workspace-upgrades/UpgradeRunProgress"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { useNow } from "@/lib/useNow"
import { cn } from "@/lib/utils"

import { ingestionProgress } from "../ingestion"
import { StatusTag } from "../StatusTag"
import { WorkspaceRootFolderField } from "../WorkspaceRootFolderField"
import type {
  AttentionItem,
  SettingsModel,
  SourceActivity,
  UpgradeView,
} from "./use-settings-model"

const TONE = {
  attention: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  good: "border-teal-400/30 bg-teal-400/10 text-teal-200",
  neutral: "border-border bg-zinc-800 text-muted-foreground",
  error: "border-red-400/30 bg-red-400/10 text-red-200",
} as const

/** The main action of one thing that needs the user. */
type MainAction =
  | { kind: "press"; label: string; onPress: () => void; pending: boolean }
  | { kind: "href"; label: string; href: string }
  | { kind: "ask"; text: string }

/** One thing that needs the user: an upgrade, write access, or the graph. */
type Card = {
  id: string
  tone: "attention" | "error"
  /** The state line text when this card leads. */
  line: string
  main: MainAction | null
  upgrade?: UpgradeView
  attention?: AttentionItem
  stalled?: boolean
}

function upgradeMain(view: UpgradeView): MainAction | null {
  if (view.canStart)
    return {
      kind: "press",
      label:
        view.item.kind === "reingest"
          ? `Start the re-ingestion${view.item.status === "failed" ? " again" : ""}`
          : `Start the upgrade${view.item.status === "failed" ? " again" : ""}`,
      onPress: view.start,
      pending: view.starting,
    }
  if (view.pullRequest && view.item.status === "pr_open" && !view.item.mergedAt)
    return {
      kind: "href",
      label: "Open pull request",
      href: view.pullRequest.url,
    }
  if (view.canCheck)
    return {
      kind: "press",
      label: "Check again",
      onPress: view.check,
      pending: view.checking,
    }
  if (view.memberAsk) return { kind: "ask", text: view.memberAsk }
  return null
}

function upgradeLine(view: UpgradeView): string {
  const status = view.item.status
  if (status === "awaiting_operator") return `${view.title} is ready to start.`
  if (status === "failed") return `${view.title} failed.`
  if (status === "pr_open")
    return view.pullRequest?.number
      ? `Merge pull request #${view.pullRequest.number} to finish ${view.title.toLowerCase()}.`
      : `Merge the pull request to finish ${view.title.toLowerCase()}.`
  if (view.blocked) return `${view.blocked.title}.`
  return `${view.title}: ${view.tag.label.toLowerCase()}.`
}

function buildCards(model: SettingsModel): Card[] {
  const { access } = model
  const cards = model.attention.map((attention): Card => {
    if (attention.part === "upgrades") {
      const view = model.upgrades.needsYou.find(
        (item) => `upgrade:${item.key}` === attention.id,
      )
      return {
        id: attention.id,
        tone: attention.tone,
        line: view ? upgradeLine(view) : attention.title,
        main: view ? upgradeMain(view) : null,
        ...(view ? { upgrade: view } : {}),
      }
    }
    if (attention.part === "access")
      return {
        id: attention.id,
        tone: attention.tone,
        line: `${attention.title}.`,
        main: access.needsRelink
          ? {
              kind: "press",
              label: "Select the repository again",
              onPress: model.repository.openRelink,
              pending: false,
            }
          : {
              kind: "press",
              label: "Check again",
              onPress: access.checkAgain,
              pending: access.checking,
            },
        attention,
      }
    return {
      id: attention.id,
      tone: attention.tone,
      line: `${attention.title}.`,
      main: null,
      attention,
    }
  })
  if (access.stalled && !cards.some((card) => card.id === "access"))
    cards.push({
      id: "stalled",
      tone: "attention",
      line: "The write access check takes longer than usual.",
      main: {
        kind: "press",
        label: "Check again",
        onPress: access.checkAgain,
        pending: access.checking,
      },
      stalled: true,
    })
  // A problem leads: it blocks the Workspace, a start only waits.
  return [
    ...cards.filter((card) => card.tone === "error"),
    ...cards.filter((card) => card.tone !== "error"),
  ]
}

function MainActionButton(props: {
  action: MainAction
  variant: "primary" | "secondary"
}) {
  const { action } = props
  if (action.kind === "ask")
    return (
      <p className="text-xs text-muted-foreground">{action.text} to do this.</p>
    )
  if (action.kind === "href")
    return (
      <Button
        variant={props.variant}
        href={action.href}
        target="_blank"
        rel="noreferrer"
      >
        <IconGitPullRequest className="size-4" aria-hidden />
        {action.label}
      </Button>
    )
  return (
    <Button
      variant={props.variant}
      isPending={action.pending}
      onPress={action.onPress}
    >
      {action.label}
    </Button>
  )
}

/** The one line for the whole Workspace, and at most one primary action. */
function StateLine(props: {
  model: SettingsModel
  cards: Card[]
  working: boolean
}) {
  const { model, cards } = props
  const loading = useSkeletonHold(model.upgrades.status === "loading")
  const lead = cards[0]
  const more = cards.length - 1
  let tag: { label: string; className: string; pulse?: boolean }
  let line: string
  if (lead) {
    tag =
      lead.tone === "error"
        ? { label: "Problem", className: TONE.error }
        : { label: "Needs you", className: TONE.attention }
    line =
      more > 0
        ? `${lead.line} ${more} more ${more === 1 ? "thing needs" : "things need"} you.`
        : lead.line
  } else if (model.upgrades.status === "error") {
    tag = { label: "Problem", className: TONE.error }
    line = "Could not load the upgrades."
  } else if (props.working) {
    tag = { label: "Working", className: TONE.good, pulse: true }
    line =
      model.upgrades.headline?.label === "Working"
        ? model.upgrades.headline.line
        : model.graph.status === "running"
          ? "No action needed. ctxpipe loads the knowledge graph now."
          : "No action needed. ctxpipe works on this Workspace now."
  } else {
    tag = { label: "Up to date", className: TONE.good }
    line = "Nothing needs you, and nothing runs now."
  }
  if (!lead && loading)
    return (
      <div className="flex min-h-9 items-center gap-3" aria-busy>
        <span className="sr-only">Loading the Workspace state</span>
        <Skeleton className="h-5.5 w-24" />
        <SkeletonText className="text-sm" boneClassName="w-72" />
      </div>
    )
  return (
    <section
      aria-label="Workspace state"
      className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-3"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <StatusTag {...tag} />
        <p className="text-sm text-foreground">{line}</p>
      </div>
      {lead?.main ? (
        <MainActionButton action={lead.main} variant="primary" />
      ) : null}
    </section>
  )
}

/** A card frame: the tone shows on the border and the icon, not as a slab. */
function CardFrame(props: {
  tone: "attention" | "error"
  title: string
  tag?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  const Icon = props.tone === "error" ? IconAlertCircle : IconAlertTriangle
  return (
    <li
      aria-label={props.title}
      className={cn(
        "rounded-md border bg-white/[0.02] p-4",
        props.tone === "error" ? "border-red-400/30" : "border-amber-400/25",
      )}
    >
      <div className="flex items-start gap-3">
        <Icon
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0",
            props.tone === "error" ? "text-red-300" : "text-amber-300",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <h3 className="text-sm font-medium text-foreground">
              {props.title}
            </h3>
            {props.tag}
          </div>
          <div className="mt-1 flex flex-col gap-3 text-sm text-muted-foreground">
            {props.children}
          </div>
          {props.footer ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {props.footer}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  )
}

/** The steps, the notices, and the report details of a format upgrade. */
function UpgradeDetails(props: { view: UpgradeView }) {
  const { view } = props
  const withReport = view.steps.filter((step) => step.report.length > 0)
  return (
    <>
      {view.steps.length > 0 ? (
        <ol
          className="flex flex-col gap-1.5 text-xs"
          aria-label={`Steps of ${view.title}`}
        >
          {view.steps.map((step, index) => (
            <li key={step.format} className="flex items-baseline gap-2">
              <span className="w-4 shrink-0 tabular-nums">{index + 1}</span>
              <span className="text-foreground">{step.title}</span>
              {step.commitSha ? (
                <code className="font-mono">{step.commitSha.slice(0, 7)}</code>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {view.notices.length > 0 ? (
        <ul
          className="flex flex-col gap-1.5 text-xs"
          aria-label={`Notes of ${view.title}`}
        >
          {view.notices.map((notice) => (
            <li
              key={`${notice.kind}-${notice.text}`}
              className="flex items-start gap-2"
            >
              {notice.kind === "action" ? (
                <IconArrowRight
                  aria-hidden
                  className="mt-px size-3.5 shrink-0 text-foreground"
                />
              ) : (
                <IconAlertTriangle
                  aria-hidden
                  className="mt-px size-3.5 shrink-0 text-amber-300"
                />
              )}
              <span
                className={
                  notice.kind === "action" ? "text-foreground" : undefined
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
      {withReport.length > 0 ? (
        <Disclosure className="-mx-2">
          <DisclosureHeader>
            <span className="text-xs text-muted-foreground">Details</span>
          </DisclosureHeader>
          <DisclosurePanel className="px-2">
            <div className="flex flex-col gap-2 pb-1 text-xs">
              {withReport.map((step) => (
                <div key={step.format}>
                  <p className="text-foreground">
                    Format {step.format}: {step.title}
                  </p>
                  <ul className="mt-1 flex flex-col gap-1 break-words">
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
    </>
  )
}

function UpgradeCard(props: {
  view: UpgradeView
  promoted: boolean
  lastSpend: string | null
  orgSlug: string
  onFixWithAgent: ((prompt: string) => void) | undefined
}) {
  const { view, promoted } = props
  const main = upgradeMain(view)
  const failure = view.failure
  const tone = view.item.status === "failed" ? "error" : "attention"
  const hasFooter =
    (main !== null && !promoted) ||
    (main?.kind === "href" && view.canCheck) ||
    Boolean(failure?.fixPrompt && props.onFixWithAgent) ||
    Boolean(failure?.connectorsHref) ||
    (view.pullRequest !== null && main?.kind !== "href")
  const footer = hasFooter ? (
    <>
      {main && !promoted ? (
        <MainActionButton action={main} variant="secondary" />
      ) : null}
      {main?.kind === "href" && view.canCheck ? (
        <Button
          variant="secondary"
          isPending={view.checking}
          onPress={view.check}
          aria-label={`Check again: ${view.title}`}
        >
          Check again
        </Button>
      ) : null}
      {failure?.fixPrompt && props.onFixWithAgent ? (
        <Button
          variant="secondary"
          onPress={() =>
            failure.fixPrompt && props.onFixWithAgent?.(failure.fixPrompt)
          }
        >
          Fix using agent
        </Button>
      ) : null}
      {failure?.connectorsHref ? (
        <Link href={failure.connectorsHref} className="text-xs">
          {failure.connectorsLabel}
        </Link>
      ) : null}
      {view.pullRequest && main?.kind !== "href" ? (
        <Link
          href={view.pullRequest.url}
          target="_blank"
          rel="noreferrer"
          variant="secondary"
          className="inline-flex items-center gap-1.5 text-xs"
        >
          <IconGitPullRequest className="size-4" aria-hidden />
          {view.pullRequest.number
            ? `Pull request #${view.pullRequest.number}`
            : "Pull request"}
        </Link>
      ) : null}
    </>
  ) : null
  return (
    <CardFrame
      tone={tone}
      title={view.title}
      tag={<StatusTag {...view.tag} />}
      footer={footer}
    >
      <p>{view.description}</p>
      {view.item.kind === "reingest" &&
      view.item.status === "awaiting_operator" &&
      props.lastSpend ? (
        <p className="flex items-start gap-2 text-xs">
          <IconCoin
            aria-hidden
            className="mt-px size-3.5 shrink-0 text-amber-300"
          />
          <span>
            <span className="text-foreground">
              The last re-ingestion cost {props.lastSpend}.
            </span>
          </span>
        </p>
      ) : null}
      <UpgradeDetails view={view} />
      {view.blocked ? (
        <p className="text-xs">
          <span className="text-foreground">{view.blocked.title}.</span>{" "}
          {view.blocked.body}
        </p>
      ) : view.note ? (
        <p className="text-xs">{view.note}</p>
      ) : null}
      {view.waiting ? <p className="text-xs">{view.waiting}</p> : null}
      {failure ? (
        <div className="flex flex-col gap-1 text-xs">
          {failure.step ? (
            <p>
              Failed step:{" "}
              <span className="text-foreground">{failure.step}</span>
            </p>
          ) : null}
          <p className="text-foreground">{failure.reason}</p>
          <p className="break-words">Details: {failure.summary}</p>
          <p className="text-foreground">{failure.action}</p>
          {failure.autoRetried ? (
            <p>ctxpipe already started this upgrade again once by itself.</p>
          ) : null}
        </div>
      ) : null}
      {view.failureReason ? (
        <p className="text-xs text-foreground">{view.failureReason}</p>
      ) : null}
      {view.checkResult || view.spend ? (
        <p className="text-xs">
          {[view.checkResult, view.spend ? `${view.spend}.` : null]
            .filter(Boolean)
            .join(" ")}
        </p>
      ) : null}
    </CardFrame>
  )
}

function SkippedFilesCard(props: { model: SettingsModel; title: string }) {
  const { graph, workspace } = props.model
  const inGit = (path: string) =>
    workspace.skippedFiles?.find((file) => file.path === path)?.source !==
    "legacy-overlay"
  return (
    <CardFrame tone="attention" title={props.title}>
      <p>
        Chat, MCP, search, and the graph do not use these files.
        {graph.skippedFiles.some((file) => inGit(file.path))
          ? " Fix each file that is in Git and push the change to the default branch."
          : ""}
      </p>
      <ul className="flex flex-col divide-y divide-white/[0.06]">
        {graph.skippedFiles.map((file) => (
          <li
            key={file.path}
            className="flex min-w-0 items-center justify-between gap-3 py-2"
          >
            <div className="min-w-0">
              {/* A legacy overlay path is not in Git: the Files pane cannot open it. */}
              {inGit(file.path) ? (
                <AriaLink
                  onPress={() => graph.openFile(file.path)}
                  className={cn(
                    "block cursor-pointer truncate rounded-md font-mono text-xs text-foreground underline decoration-white/30 underline-offset-2 hover:decoration-white",
                    focusVisibleClassName,
                  )}
                >
                  {file.path}
                </AriaLink>
              ) : (
                <span className="block truncate font-mono text-xs text-foreground">
                  {file.path}
                </span>
              )}
              <p className="text-xs">{file.text}</p>
            </div>
            {file.fixPrompt && graph.fixWithAgent ? (
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                aria-label={`Fix ${file.path} using agent`}
                onPress={() =>
                  file.fixPrompt && graph.fixWithAgent?.(file.fixPrompt)
                }
              >
                Fix using agent
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </CardFrame>
  )
}

function NeedsYou(props: { model: SettingsModel; cards: Card[] }) {
  const { model, cards } = props
  const lastReingest = model.upgrades.done.find(
    (view) => view.item.kind === "reingest" && view.spend,
  )
  return (
    <section aria-labelledby="needs-you" className="flex flex-col gap-3">
      <h2 id="needs-you" className="ctx-label text-muted-foreground">
        Needs you
      </h2>
      <ul className="flex flex-col gap-3">
        {cards.map((card, index) => {
          const promoted = index === 0
          if (card.upgrade)
            return (
              <UpgradeCard
                key={card.id}
                view={card.upgrade}
                promoted={promoted}
                lastSpend={lastReingest?.spend?.replace(/^Spend: /, "") ?? null}
                orgSlug={model.orgSlug}
                onFixWithAgent={model.graph.fixWithAgent}
              />
            )
          if (card.id === "skipped" && card.attention)
            return (
              <SkippedFilesCard
                key={card.id}
                model={model}
                title={card.attention.title}
              />
            )
          const main =
            card.main && !promoted ? (
              <MainActionButton action={card.main} variant="secondary" />
            ) : null
          if (card.stalled)
            return (
              <CardFrame
                key={card.id}
                tone="attention"
                title="Still checking write access"
                footer={main}
              >
                <p>The check takes longer than usual.</p>
              </CardFrame>
            )
          if (card.id === "access" && card.attention)
            return (
              <CardFrame
                key={card.id}
                tone={card.tone}
                title={card.attention.title}
                footer={main}
              >
                <p>{card.attention.body}</p>
                {model.access.writeStatus === "read_only" ? (
                  <p className="text-xs">
                    Until you fix it, conversations cannot save changes. After
                    the fix, press Check again. ctxpipe also checks by itself,
                    at most once a minute.
                  </p>
                ) : null}
              </CardFrame>
            )
          return (
            <CardFrame
              key={card.id}
              tone={card.tone}
              title={card.attention?.title ?? card.line}
              footer={main}
            >
              <p>{card.attention?.body}</p>
            </CardFrame>
          )
        })}
      </ul>
    </section>
  )
}

const STAGE_WORD: Record<string, string> = {
  publishing: "publishing",
  ingesting: "reading the code",
  indexing: "indexing",
  planning: "planning",
  waiting: "waiting",
  queued: "queued",
}

function stageBreakdown(source: SourceActivity): string {
  const counts = new Map<string, number>()
  for (const run of source.runs) {
    const word = STAGE_WORD[run.stage ?? ""] ?? "syncing"
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts].map(([word, count]) => `${count} ${word}`).join(", ")
}

function PulseDot(props: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "ctx-status-pulse size-1.5 shrink-0 rounded-full bg-teal-400",
        props.className,
      )}
    />
  )
}

/** One row for each source: the runs of one repository are grouped. */
function SourceRow(props: { source: SourceActivity; now: number }) {
  const { source, now } = props
  const runs = source.runs.length
  const summary = (
    <span className="flex min-w-0 items-center gap-3">
      <PulseDot />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-sm font-normal text-foreground">
          {source.title}
        </span>
        <span className="block truncate text-xs font-normal text-muted-foreground">
          {source.progress.label}
          {runs > 1 ? ` · ${runs} runs` : ""}
          {source.progress.count ? ` · ${source.progress.count}` : ""} ·{" "}
          <span className="tabular-nums">
            {formatElapsed(source.since, now)}
          </span>
        </span>
      </span>
    </span>
  )
  if (runs === 1)
    return (
      <li className="px-2 py-1.5" aria-label={source.title}>
        {summary}
      </li>
    )
  return (
    <li aria-label={source.title}>
      <Disclosure className="-mx-0">
        <DisclosureHeader>{summary}</DisclosureHeader>
        <DisclosurePanel>
          <div className="mb-2 ml-6 mr-2 rounded-md bg-white/[0.03] px-3 py-2 text-xs">
            <p className="text-muted-foreground">{stageBreakdown(source)}</p>
            <ul
              className="mt-2 flex flex-col gap-1.5"
              aria-label={`Runs of ${source.title}`}
            >
              {source.runs.map((run) => {
                const progress = ingestionProgress(run)
                return (
                  <li key={run.id}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-foreground">{progress.label}</span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {progress.count ? `${progress.count} · ` : ""}
                        {formatElapsed(run.startedAt, now)}
                      </span>
                    </div>
                    {progress.detail ? (
                      <p className="text-muted-foreground">{progress.detail}</p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </div>
        </DisclosurePanel>
      </Disclosure>
    </li>
  )
}

function WorkingUpgradeRow(props: { view: UpgradeView }) {
  const { view } = props
  return (
    <li className="px-2 py-1.5" aria-label={view.title}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-sm text-foreground">{view.title}</p>
        <StatusTag {...view.tag} />
      </div>
      {view.progress ? (
        <UpgradeRunProgress
          title={view.title}
          progress={view.progress}
          hideLeaveHint
        />
      ) : null}
      {view.waiting ? (
        <p className="mt-1 text-xs text-muted-foreground">{view.waiting}</p>
      ) : null}
      {view.spend ? (
        <p className="mt-2 text-xs text-muted-foreground">{view.spend}.</p>
      ) : null}
    </li>
  )
}

function RunningNow(props: { model: SettingsModel }) {
  const { model } = props
  const { activity, upgrades } = model
  const reingestUpgrade = upgrades.working.some(
    (view) => view.item.kind === "reingest",
  )
  // The working re-ingestion already shows its progress: no second row.
  const sources = activity.sources.filter(
    (source) => !(reingestUpgrade && source.kind === "reingest"),
  )
  const hydrate = activity.hydrate
  const now = useNow(sources.length > 0 || hydrate !== null)
  const loading = useSkeletonHold(activity.status === "loading")
  if (
    upgrades.working.length === 0 &&
    activity.label === null &&
    activity.status !== "error"
  )
    return null
  return (
    <section aria-labelledby="running-now" className="flex flex-col gap-2">
      <h2 id="running-now" className="ctx-label text-muted-foreground">
        Running now
      </h2>
      <ul className="-mx-2 flex flex-col">
        {upgrades.working.map((view) => (
          <WorkingUpgradeRow key={view.key} view={view} />
        ))}
        {sources.map((source) => (
          <SourceRow key={source.key} source={source} now={now} />
        ))}
        {hydrate ? (
          <li className="px-2 py-1.5">
            <span className="flex items-center gap-3 text-sm text-muted-foreground">
              <PulseDot />
              Indexing the newest commit
              <span className="text-xs tabular-nums">
                {formatElapsed(hydrate.startedAt, now)}
              </span>
            </span>
          </li>
        ) : null}
      </ul>
      {loading ? (
        <div className="flex flex-col gap-2 px-0" aria-busy>
          <span className="sr-only">Loading the running work</span>
          <SkeletonText className="text-sm" boneClassName="w-56" />
          <SkeletonText className="text-xs opacity-50" boneClassName="w-40" />
        </div>
      ) : activity.status === "error" ? (
        <InlineAlert
          variant="error"
          actions={
            <Button variant="secondary" onPress={activity.retry}>
              Try again
            </Button>
          }
        >
          Could not load the running work.
        </InlineAlert>
      ) : sources.length > 0 ||
        upgrades.working.some((view) => view.progress !== null) ? (
        <p className="text-xs text-muted-foreground">
          You can leave this page. The work continues.
        </p>
      ) : null}
    </section>
  )
}

function Fact(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 @xl:flex-row @xl:gap-4">
      <dt className="shrink-0 text-xs text-muted-foreground @xl:w-36 @xl:pt-0.5">
        {props.label}
      </dt>
      <dd className="min-w-0 flex-1 text-sm text-foreground">
        {props.children}
      </dd>
    </div>
  )
}

function Dot(props: { tone: "good" | "attention" | "error" | "working" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mr-2 inline-block size-1.5 shrink-0 translate-y-[-0.1rem] rounded-full",
        props.tone === "good" && "bg-teal-400/70",
        props.tone === "attention" && "bg-amber-300",
        props.tone === "error" && "bg-red-400",
        props.tone === "working" && "ctx-status-pulse bg-teal-400",
      )}
    />
  )
}

function Health(props: { model: SettingsModel }) {
  const { model } = props
  const { access, graph, upgrades, repository } = model
  const upgradesLoading = useSkeletonHold(upgrades.status === "loading")
  const repo = repository.title
  const writeFact =
    access.tone === "writable" ? (
      <>
        <Dot tone="good" />
        ctxpipe can push to {repo}.
      </>
    ) : access.tone === "pull_request" ? (
      <>
        <Dot tone="good" />
        By pull request. {access.description}
      </>
    ) : access.tone === "pending" ? (
      <>
        <Dot tone="working" />
        ctxpipe checks if it can push to {repo}.
      </>
    ) : access.tone === "check_failed" ? (
      <>
        <Dot tone="attention" />
        Unknown. ctxpipe could not check it.
      </>
    ) : (
      <>
        <Dot tone="attention" />
        ctxpipe cannot push to {repo}.
      </>
    )
  const graphFact =
    graph.status === "ready" ? (
      <>
        <Dot tone="good" />
        Loaded
      </>
    ) : graph.status === "failed" ? (
      <>
        <Dot tone="error" />
        Did not load
      </>
    ) : graph.status === "running" ? (
      <>
        <Dot tone="working" />
        Loading
      </>
    ) : (
      <>
        <Dot tone="working" />
        Waiting to load
      </>
    )
  const skipped = graph.skippedFiles.length
  const lag = graph.projectionLag
  return (
    <section aria-labelledby="health" className="flex flex-col gap-1">
      <h2 id="health" className="ctx-label text-muted-foreground">
        Health
      </h2>
      <dl className="flex flex-col divide-y divide-white/[0.04]">
        <Fact label="Write access">{writeFact}</Fact>
        <Fact label="Knowledge graph">{graphFact}</Fact>
        <Fact label="Knowledge files">
          {skipped ? (
            <>
              <Dot tone="attention" />
              {skipped} skipped. Chat and search do not use them.
            </>
          ) : (
            <>
              <Dot tone="good" />
              No files skipped
            </>
          )}
        </Fact>
        {lag ? (
          <Fact label="Answers from">
            <Dot tone="working" />
            <span className="font-mono text-xs">
              {githubRepoFullNameFromGitUrl(lag) ?? lag}
            </span>{" "}
            until <span className="font-mono text-xs">{repository.title}</span>{" "}
            finishes loading.
          </Fact>
        ) : null}
        <Fact label="Upgrades">
          {upgradesLoading ? (
            <span className="flex flex-col gap-1" aria-busy>
              <span className="sr-only">Loading upgrades</span>
              <SkeletonText className="text-sm" boneClassName="w-56" />
              <SkeletonText className="text-xs" boneClassName="w-40" />
            </span>
          ) : upgrades.status === "error" ? (
            <span className="text-muted-foreground">Could not load.</span>
          ) : (
            <span className="flex flex-col">
              <span className="flex min-h-7 flex-wrap items-center gap-x-2">
                <span>{upgrades.formatLine}</span>
                <span className="contents text-xs text-muted-foreground">
                  <AutomaticUpgradesToggle
                    orgSlug={model.orgSlug}
                    workspaceSlug={model.workspace.slug}
                    isAdmin={model.isAdmin}
                  />
                </span>
              </span>
              {upgrades.done.length > 0 && upgrades.historyLine ? (
                <Disclosure className="-mx-2">
                  <DisclosureHeader>
                    <span className="text-xs font-normal text-muted-foreground">
                      {upgrades.historyLine}
                    </span>
                  </DisclosureHeader>
                  <DisclosurePanel className="px-2">
                    <ul
                      className="flex flex-col gap-3 pb-2 pt-1"
                      aria-label="Applied upgrades"
                    >
                      {upgrades.done.map((view) => (
                        <li key={view.key} className="text-xs">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-foreground">
                              {view.title}
                            </span>
                            <StatusTag {...view.tag} />
                          </div>
                          <p className="mt-1 text-muted-foreground">
                            {[
                              view.spend ? `${view.spend}.` : null,
                              view.item.kind === "format"
                                ? `Format ${view.item.fromFormat} to format ${view.item.targetFormat}.`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" ")}{" "}
                            {view.pullRequest ? (
                              <Link
                                href={view.pullRequest.url}
                                target="_blank"
                                rel="noreferrer"
                                variant="secondary"
                              >
                                {view.pullRequest.number
                                  ? `Pull request #${view.pullRequest.number}`
                                  : "Pull request"}
                              </Link>
                            ) : null}
                          </p>
                          {view.steps.length ? (
                            <UpgradeDetailsQuiet view={view} />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </DisclosurePanel>
                </Disclosure>
              ) : null}
            </span>
          )}
        </Fact>
      </dl>
    </section>
  )
}

/** The steps of an applied upgrade, in one quiet line. */
function UpgradeDetailsQuiet(props: { view: UpgradeView }) {
  return (
    <p className="mt-1 text-muted-foreground">
      Steps: {props.view.steps.map((step) => step.title).join(", ")}.
    </p>
  )
}

function Overview(props: { model: SettingsModel; cards: Card[] }) {
  const { model, cards } = props
  return (
    <div className="flex flex-col gap-8">
      {model.upgrades.status === "error" ? (
        <InlineAlert
          variant="error"
          title="Could not load the upgrades"
          actions={
            <Button variant="secondary" onPress={model.upgrades.retry}>
              Try again
            </Button>
          }
        >
          ctxpipe cannot show if an upgrade waits for you.
        </InlineAlert>
      ) : null}
      {cards.length > 0 ? <NeedsYou model={model} cards={cards} /> : null}
      <RunningNow model={model} />
      <Health model={model} />
    </div>
  )
}

/** A settings section: the name and one line on the left when wide. */
function SettingsSection(props: {
  id: string
  title: string
  about: string
  children: ReactNode
}) {
  return (
    <section
      aria-labelledby={props.id}
      className="grid gap-4 border-t border-white/[0.06] py-6 first:border-t-0 first:pt-0 @3xl:grid-cols-3 @3xl:gap-8"
    >
      <div>
        <h2 id={props.id} className="text-sm font-medium text-foreground">
          {props.title}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{props.about}</p>
      </div>
      <div className="min-w-0 @3xl:col-span-2">{props.children}</div>
    </section>
  )
}

function Settings(props: { model: SettingsModel }) {
  const { model } = props
  const { general, repository } = model
  return (
    <div className="flex flex-col">
      <SettingsSection
        id="settings-general"
        title="General"
        about="How your team finds this Workspace."
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (general.dirty) general.save()
          }}
        >
          <div className="grid items-start gap-4 @xl:grid-cols-2">
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
          </div>
          <div className="flex items-center justify-end gap-2">
            {general.dirty ? (
              <Button
                variant="quiet"
                isDisabled={general.saving}
                onPress={general.reset}
              >
                Discard
              </Button>
            ) : null}
            <Button
              type="submit"
              variant="secondary"
              isPending={general.saving}
              isDisabled={!general.dirty}
            >
              Save
            </Button>
          </div>
        </form>
      </SettingsSection>

      <SettingsSection
        id="settings-repository"
        title="Repository"
        about="The GitHub repository where this Workspace keeps its files."
      >
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
            <span
              aria-hidden
              className="ctx-node size-8 shrink-0 rounded-md text-muted-foreground"
            >
              <IconGitBranch className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">
                {repository.title}
              </p>
              {repository.webUrl ? (
                <Link
                  href={repository.webUrl}
                  target="_blank"
                  rel="noreferrer"
                  variant="secondary"
                  className="block truncate text-xs no-underline hover:underline"
                >
                  {repository.url}
                </Link>
              ) : (
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {repository.url}
                </p>
              )}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onPress={repository.openRelink}
            >
              Change
            </Button>
          </div>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              repository.saveRootFolder()
            }}
          >
            <WorkspaceRootFolderField
              value={repository.rootFolder}
              onChange={repository.setRootFolder}
              isDisabled={repository.savingRootFolder}
            />
            <div className="flex items-center justify-end gap-2">
              {repository.rootFolderChanged ? (
                <Button
                  variant="quiet"
                  isDisabled={repository.savingRootFolder}
                  onPress={() => repository.setRootFolder(repository.rootPath)}
                >
                  Discard
                </Button>
              ) : null}
              <Button
                type="submit"
                variant="secondary"
                isPending={repository.savingRootFolder}
                isDisabled={
                  !repository.rootFolderChanged ||
                  repository.rootFolderError !== null
                }
              >
                Save root folder
              </Button>
            </div>
          </form>
        </div>
      </SettingsSection>

      <SettingsSection
        id="settings-sources"
        title="Sources"
        about="The repositories and tools that ctxpipe reads into this Workspace."
      >
        <WorkspaceSources
          orgSlug={model.orgSlug}
          workspaceSlug={model.workspace.slug}
          linkedRepositories={repository.linkedRepositories}
        />
      </SettingsSection>

      <SettingsSection
        id="settings-danger"
        title="Danger zone"
        about="You cannot undo these actions."
      >
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-white/[0.06] px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm text-foreground">Delete this Workspace</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Deletes the Workspace and its conversations. Your GitHub
              repository and its files stay.
            </p>
          </div>
          <Button
            variant="outline"
            className="shrink-0"
            onPress={model.openDelete}
          >
            Delete Workspace
          </Button>
        </div>
      </SettingsSection>
    </div>
  )
}

export function VariantA(props: { model: SettingsModel }) {
  const { model } = props
  const cards = buildCards(model)
  const working =
    model.upgrades.working.length > 0 ||
    model.activity.label !== null ||
    model.graph.status === "running" ||
    model.graph.projectionLag !== null ||
    model.access.tone === "pending"
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 px-6 py-5">
      <div className="flex flex-col gap-3">
        <h1 className="text-lg font-medium tracking-tight">
          Workspace settings
        </h1>
        <StateLine model={model} cards={cards} working={working} />
      </div>
      <Tabs defaultSelectedKey="overview">
        <TabList
          aria-label="Workspace settings"
          className="border-b border-white/[0.06] pb-2"
        >
          <Tab id="overview">
            Overview
            {cards.length > 0 ? (
              <span
                className={cn(
                  "ml-2 rounded-md px-1.5 text-xs tabular-nums",
                  cards.some((card) => card.tone === "error")
                    ? "bg-red-400/15 text-red-200"
                    : "bg-amber-400/15 text-amber-200",
                )}
              >
                {cards.length}
              </span>
            ) : null}
          </Tab>
          <Tab id="settings">Settings</Tab>
        </TabList>
        <TabPanel id="overview" className="p-0 pt-2">
          <Overview model={model} cards={cards} />
        </TabPanel>
        <TabPanel id="settings" className="p-0 pt-2">
          <Settings model={model} />
        </TabPanel>
      </Tabs>
    </div>
  )
}
