/**
 * PROTOTYPE, throwaway (see prototype-variant.ts). Variant B, "Health rail
 * and edit rows". A rail lists the parts of the Workspace, each with a status
 * dot and a word; a part that needs the user opens in place. The settings are
 * rows with a value and an Edit button; each edit has its own dialog and its
 * own Save, so no Save button on the page saves more than one thing.
 */
import {
  IconAlertTriangle,
  IconArrowRight,
  IconChevronRight,
  IconExternalLink,
  IconGitPullRequest,
} from "@tabler/icons-react"
import { type ReactNode, useState } from "react"
import { Heading } from "react-aria-components"

import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import {
  Disclosure,
  DisclosureHeader,
  DisclosurePanel,
} from "@/components/ui/Disclosure"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Link as TextLink } from "@/components/ui/Link"
import { Modal } from "@/components/ui/Modal"
import {
  Skeleton,
  SkeletonText,
  useSkeletonHold,
} from "@/components/ui/Skeleton"
import { TextField } from "@/components/ui/TextField"
import { WorkspaceSources } from "@/features/workspace-sources/WorkspaceSources"
import { AutomaticUpgradesToggle } from "@/features/workspace-upgrades/AutomaticUpgradesToggle"
import { formatElapsed } from "@/features/workspace-upgrades/upgrade-progress"
import { UpgradeRunProgress } from "@/features/workspace-upgrades/UpgradeRunProgress"
import { useNow } from "@/lib/useNow"
import { cn } from "@/lib/utils"

import { StatusTag } from "../StatusTag"
import type {
  SettingsModel,
  SourceActivity,
  UpgradeView,
} from "./use-settings-model"

const TONE = {
  good: "border-teal-400/30 bg-teal-400/10 text-teal-200",
  attention: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  error: "border-red-400/30 bg-red-400/10 text-red-200",
  neutral: "border-border bg-zinc-800 text-muted-foreground",
} as const

type Tag = { label: string; className: string; pulse?: boolean }

/** One part of the Workspace in the Health rail. */
type HealthPart = {
  id: string
  title: string
  /** Null while the part loads: the tag is a bone. */
  tag: Tag | null
  summary: ReactNode
  needsYou: boolean
  running: boolean
  details: ReactNode
}

export function VariantB(props: { model: SettingsModel }) {
  const { model } = props
  const parts = [
    accessPart(model),
    graphPart(model),
    useSourcesPart(model),
    useUpgradesPart(model),
  ]
  const needsYou = parts.filter((part) => part.needsYou).length
  const running = parts.filter((part) => part.running).length
  const loading = parts.some((part) => part.tag === null)

  return (
    <div className="flex flex-col @3xl:h-full">
      <header className="shrink-0 border-b border-white/[0.06] px-6 py-4">
        <h1 className="text-lg font-medium tracking-tight">
          Workspace settings
        </h1>
      </header>

      <div className="grid @3xl:min-h-0 @3xl:flex-1 @3xl:grid-cols-[22rem_minmax(0,1fr)] @5xl:grid-cols-[26rem_minmax(0,1fr)]">
        {/* The rail scrolls on its own when the pane is wide, so it stays in view. */}
        <section
          aria-labelledby="health-rail"
          className="border-b border-white/[0.06] px-4 py-5 @3xl:overflow-y-auto @3xl:border-r @3xl:border-b-0"
        >
          <div className="px-2">
            <h2 id="health-rail" className="ctx-label text-muted-foreground">
              Health
            </h2>
            {loading ? (
              <SkeletonText className="mt-2 text-sm" boneClassName="w-56" />
            ) : (
              <p className="mt-2 flex items-center gap-2 text-sm text-foreground">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    needsYou ? "bg-amber-300" : "bg-teal-400",
                  )}
                />
                {needsYou === 0 && running === 0
                  ? "Nothing needs you and nothing runs."
                  : [
                      needsYou
                        ? `${needsYou} ${needsYou === 1 ? "part needs" : "parts need"} you`
                        : "Nothing needs you",
                      running ? `${running} running` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </p>
            )}
          </div>
          <ul className="mt-4 flex flex-col gap-1">
            {parts.map((part) => (
              <HealthRow key={part.id} part={part} />
            ))}
          </ul>
        </section>

        <div className="px-6 py-5 @3xl:overflow-y-auto">
          <SettingsColumn model={model} />
        </div>
      </div>
    </div>
  )
}

/** A row of the rail. It opens by itself while its part needs the user. */
function HealthRow(props: { part: HealthPart }) {
  const { part } = props
  const [override, setOverride] = useState<boolean | null>(null)
  const expanded = override ?? part.needsYou
  return (
    <li>
      <Disclosure
        isExpanded={expanded}
        onExpandedChange={setOverride}
        className={cn(
          "min-w-0 rounded-md",
          expanded && "bg-white/[0.02] ring-1 ring-white/[0.06]",
        )}
      >
        <h3 className="m-0">
          <Button
            slot="trigger"
            variant="ghost"
            className="h-auto w-full items-start justify-start gap-2 px-2 py-2 text-left"
          >
            <IconChevronRight
              aria-hidden
              className={cn(
                "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-90",
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">
                {part.title}
              </span>
              {/* An open row shows its details in place of the summary. */}
              {expanded ? null : (
                <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
                  {part.summary}
                </span>
              )}
            </span>
            {part.tag ? (
              <StatusTag {...part.tag} />
            ) : (
              <Skeleton className="h-5.5 w-20" />
            )}
          </Button>
        </h3>
        <DisclosurePanel>
          <div className="flex flex-col gap-3 pr-3 pb-3 pl-8 text-sm">
            {part.details}
          </div>
        </DisclosurePanel>
      </Disclosure>
    </li>
  )
}

function accessPart(model: SettingsModel): HealthPart {
  const { access, repository } = model
  const fix = access.needsRelink ? (
    <Button
      variant="secondary"
      className="self-start"
      onPress={repository.openRelink}
    >
      Select the repository again
    </Button>
  ) : (
    <Button
      variant="secondary"
      className="self-start"
      isPending={access.checking}
      onPress={access.checkAgain}
    >
      Check again
    </Button>
  )
  const base = { id: "access", title: "Repository access" }
  if (access.stalled)
    return {
      ...base,
      tag: { label: "Still checking", className: TONE.attention },
      summary: "The check takes longer than usual.",
      needsYou: true,
      running: false,
      details: (
        <>
          <p className="text-muted-foreground">
            ctxpipe checks if the GitHub App can push to this repository. The
            check takes longer than usual.
          </p>
          {fix}
        </>
      ),
    }
  if (access.tone === "writable")
    return {
      ...base,
      tag: { label: "Can push", className: TONE.good },
      summary: "ctxpipe can push to the repository.",
      needsYou: false,
      running: false,
      details: <p className="text-muted-foreground">{access.description}.</p>,
    }
  if (access.tone === "pull_request")
    return {
      ...base,
      tag: { label: "By pull request", className: TONE.good },
      summary: "Conversations open a pull request.",
      needsYou: false,
      running: false,
      details: <p className="text-muted-foreground">{access.description}</p>,
    }
  if (access.tone === "pending")
    return {
      ...base,
      tag: { label: "Checking", className: TONE.neutral, pulse: true },
      summary: "ctxpipe checks write access now.",
      needsYou: false,
      running: true,
      details: <p className="text-muted-foreground">{access.description}.</p>,
    }
  if (access.tone === "check_failed")
    return {
      ...base,
      tag: { label: "Not checked", className: TONE.attention },
      summary: "ctxpipe could not check write access.",
      needsYou: true,
      running: false,
      details: (
        <>
          <p className="text-muted-foreground">{access.description}</p>
          {fix}
        </>
      ),
    }
  return {
    ...base,
    tag: { label: "Read-only", className: TONE.attention },
    summary: "ctxpipe cannot push to the repository.",
    needsYou: true,
    running: false,
    details: (
      <>
        <p className="text-foreground">{access.description}</p>
        <p className="text-xs text-muted-foreground">
          {access.needsRelink
            ? "No GitHub connection reads this repository. After GitHub can see it, select it again."
            : "After you fix it, check again. ctxpipe also checks again at most once a minute."}
        </p>
        {fix}
      </>
    ),
  }
}

function graphPart(model: SettingsModel): HealthPart {
  const { graph, workspace } = model
  const skipped = graph.skippedFiles.length
  const failed = graph.status === "failed"
  const tag: Tag = failed
    ? { label: "Did not load", className: TONE.error }
    : skipped
      ? { label: `${skipped} skipped`, className: TONE.attention }
      : graph.status === "running"
        ? { label: "Loading", className: TONE.neutral, pulse: true }
        : graph.status === "ready"
          ? graph.indexingRun
            ? { label: "Indexing", className: TONE.good, pulse: true }
            : { label: "Loaded", className: TONE.good }
          : { label: "Waiting", className: TONE.neutral, pulse: true }
  const summary = failed
    ? skipped
      ? `The graph did not load. ${skipped} ${skipped === 1 ? "file" : "files"} skipped.`
      : "The knowledge graph did not load."
    : skipped
      ? `ctxpipe skipped ${skipped} knowledge ${skipped === 1 ? "file" : "files"}.`
      : graph.projectionLag
        ? "Answers come from the old repository for now."
        : graph.status === "running"
          ? "ctxpipe loads the graph now."
          : graph.indexingRun
            ? "Indexing the newest commit."
            : graph.status === "ready"
              ? "The graph is loaded."
              : "ctxpipe has not loaded the graph yet."
  const legacy = new Set(
    (workspace.skippedFiles ?? [])
      .filter((file) => file.source === "legacy-overlay")
      .map((file) => file.path),
  )
  const fixWithAgent = graph.fixWithAgent
  return {
    id: "graph",
    title: "Knowledge graph",
    tag,
    summary,
    needsYou: failed || skipped > 0,
    running:
      !failed &&
      (graph.status === "running" ||
        graph.status === "pending" ||
        graph.indexingRun !== null),
    details: (
      <>
        {failed ? (
          <InlineAlert variant="error" title="The graph did not load">
            {graph.error ?? "ctxpipe gives no reason."}
          </InlineAlert>
        ) : null}
        {skipped ? (
          <div className="flex flex-col gap-2">
            <p className="font-medium text-foreground">
              ctxpipe skipped {skipped} knowledge{" "}
              {skipped === 1 ? "file" : "files"}
            </p>
            <p className="text-muted-foreground">
              Chat, MCP, search, and the graph do not use these files. Fix each
              file that is in Git and push the change to the default branch.
            </p>
            <ul className="flex flex-col gap-2" aria-label="Skipped files">
              {graph.skippedFiles.map((file) => (
                <li
                  key={file.path}
                  className="rounded-md bg-white/[0.03] px-3 py-2"
                >
                  <p className="truncate font-mono text-xs text-foreground">
                    {file.path}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {file.text}
                  </p>
                  {/* A legacy overlay file is not in Git: the Files pane cannot open it. */}
                  {!legacy.has(file.path) ||
                  (file.fixPrompt && fixWithAgent) ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {legacy.has(file.path) ? null : (
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={`Open ${file.path}`}
                          onPress={() => graph.openFile(file.path)}
                        >
                          Open file
                        </Button>
                      )}
                      {file.fixPrompt && fixWithAgent ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={`Fix ${file.path} using agent`}
                          onPress={() =>
                            file.fixPrompt && fixWithAgent(file.fixPrompt)
                          }
                        >
                          Fix using agent
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {graph.projectionLag ? (
          <p className="text-muted-foreground">
            Answers still come from{" "}
            <code className="font-mono text-xs text-foreground">
              {graph.projectionLag}
            </code>{" "}
            until the new repository finishes loading.
          </p>
        ) : null}
        {graph.indexingRun ? (
          <IndexingLine since={graph.indexingRun.startedAt} />
        ) : null}
        {!failed && !skipped && !graph.projectionLag && !graph.indexingRun ? (
          <p className="text-muted-foreground">{summary}</p>
        ) : null}
      </>
    ),
  }
}

function IndexingLine(props: { since: string }) {
  const now = useNow(true)
  return (
    <p className="flex items-center gap-2 text-muted-foreground">
      <span
        aria-hidden
        className="ctx-status-pulse size-1.5 shrink-0 rounded-full bg-teal-400"
      />
      Indexing the newest commit…
      <span className="text-xs tabular-nums">
        {formatElapsed(props.since, now)}
      </span>
    </p>
  )
}

function useSourcesPart(model: SettingsModel): HealthPart {
  const { activity } = model
  const loading = useSkeletonHold(activity.status === "loading")
  const base = { id: "sources", title: "Sources" }
  if (loading)
    return {
      ...base,
      tag: null,
      summary: <SkeletonText className="text-xs" boneClassName="w-32" />,
      needsYou: false,
      running: false,
      details: <SkeletonText className="text-sm" boneClassName="w-48" />,
    }
  if (activity.status === "error")
    return {
      ...base,
      tag: { label: "Not loaded", className: TONE.error },
      summary: "Could not load the ingestion state.",
      needsYou: true,
      running: false,
      details: (
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
      ),
    }
  if (activity.sources.length === 0)
    return {
      ...base,
      tag: { label: "Up to date", className: TONE.good },
      summary: "No source syncs now.",
      needsYou: false,
      running: false,
      details: (
        <p className="text-muted-foreground">
          No source syncs now. Add or remove sources in Sources.
        </p>
      ),
    }
  return {
    ...base,
    tag: { label: "Syncing", className: TONE.good, pulse: true },
    summary: `${activity.sources.length} ${activity.sources.length === 1 ? "source syncs" : "sources sync"} now.`,
    needsYou: false,
    running: true,
    details: <SourceActivityList sources={activity.sources} />,
  }
}

const STAGE_WORD: Record<string, string> = {
  publishing: "publishing",
  ingesting: "reading the code",
  indexing: "indexing",
  planning: "planning",
  waiting: "waiting",
  queued: "queued",
}
const STAGE_ORDER = [
  "publishing",
  "ingesting",
  "indexing",
  "planning",
  "waiting",
  "queued",
]

/** "1 publishing · 4 reading the code · 1 waiting": the runs of one source. */
function runBreakdown(source: SourceActivity): string {
  const counts = new Map<string, number>()
  for (const run of source.runs) {
    const word = run.stage
      ? (STAGE_WORD[run.stage] ?? run.stage)
      : run.kind === "source_sync"
        ? "syncing"
        : "running"
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  const rank = (word: string) => {
    const stage = STAGE_ORDER.findIndex((key) => STAGE_WORD[key] === word)
    return stage === -1 ? -1 : stage
  }
  return [...counts]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([word, count]) => `${count} ${word}`)
    .join(" · ")
}

function SourceActivityList(props: { sources: SourceActivity[] }) {
  const now = useNow(true)
  return (
    <>
      <ul className="flex flex-col gap-2" aria-label="Syncing now">
        {props.sources.map((source) => (
          <li key={source.key} className="rounded-md bg-white/[0.03] px-3 py-2">
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 truncate font-mono text-xs text-foreground">
                {source.title}
              </p>
              <p className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatElapsed(source.since, now)}
              </p>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {source.runs.length > 1
                ? `${source.runs.length} runs: ${runBreakdown(source)}`
                : source.progress.label}
            </p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        You can leave this page. The work continues.
      </p>
    </>
  )
}

function useUpgradesPart(model: SettingsModel): HealthPart {
  const { upgrades, orgSlug, workspace, isAdmin } = model
  const loading = useSkeletonHold(upgrades.status === "loading")
  const base = { id: "upgrades", title: "Upgrades" }
  if (loading)
    return {
      ...base,
      tag: null,
      summary: <SkeletonText className="text-xs" boneClassName="w-40" />,
      needsYou: false,
      running: false,
      details: <SkeletonText className="text-sm" boneClassName="w-48" />,
    }
  if (upgrades.status === "error")
    return {
      ...base,
      tag: { label: "Not loaded", className: TONE.error },
      summary: "Could not load the upgrades.",
      needsYou: true,
      running: false,
      details: (
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
      ),
    }
  const needsYou =
    upgrades.needsYou.length > 0 || upgrades.headline?.label === "Needs you"
  const failed = upgrades.needsYou.some((view) => view.item.status === "failed")
  const running = upgrades.working.length > 0
  const tag: Tag = failed
    ? { label: "Failed", className: TONE.error }
    : needsYou
      ? { label: "Needs you", className: TONE.attention }
      : running
        ? { label: "Running", className: TONE.good, pulse: true }
        : { label: "Up to date", className: TONE.good }
  const first = upgrades.needsYou[0] ?? upgrades.working[0]
  const more = upgrades.needsYou.length + upgrades.working.length - 1
  const summary = first
    ? `${first.title}${more > 0 ? ` and ${more} more` : ""}`
    : (upgrades.formatLine ?? "No upgrade is open.")
  return {
    ...base,
    tag,
    summary,
    needsYou,
    running: !needsYou && running,
    details: (
      <>
        {upgrades.intro ? (
          <p className="text-xs text-muted-foreground">{upgrades.intro}</p>
        ) : null}
        {upgrades.needsYou.length || upgrades.working.length ? (
          <ul className="flex flex-col gap-3" aria-label="Open upgrades">
            {[...upgrades.needsYou, ...upgrades.working].map((view) => (
              <UpgradeCard key={view.key} view={view} model={model} />
            ))}
          </ul>
        ) : null}
        <div className="flex min-h-7 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {upgrades.formatLine ? <span>{upgrades.formatLine}</span> : null}
          <AutomaticUpgradesToggle
            orgSlug={orgSlug}
            workspaceSlug={workspace.slug}
            isAdmin={isAdmin}
          />
        </div>
        {upgrades.done.length && upgrades.historyLine ? (
          <Disclosure className="-mx-2">
            <DisclosureHeader>
              <span className="text-xs font-normal text-muted-foreground">
                {upgrades.historyLine}
              </span>
            </DisclosureHeader>
            <DisclosurePanel className="px-2">
              <ul
                className="flex flex-col gap-3 pt-1 pb-1"
                aria-label="Applied upgrades"
              >
                {upgrades.done.map((view) => (
                  <UpgradeCard key={view.key} view={view} model={model} />
                ))}
              </ul>
            </DisclosurePanel>
          </Disclosure>
        ) : null}
      </>
    ),
  }
}

/** One upgrade, with all that the card of the current page shows and does. */
function UpgradeCard(props: { view: UpgradeView; model: SettingsModel }) {
  const { view, model } = props
  const stepsWithReport = view.steps.filter((step) => step.report.length > 0)
  const fixWithAgent = model.graph.fixWithAgent
  const openPullRequest = view.pullRequest && view.group !== "done"
  return (
    <li
      className="rounded-md border border-white/[0.06] bg-background px-3 py-3"
      aria-label={view.title}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="min-w-0 text-sm font-medium text-foreground">
          {view.title}
        </h4>
        <StatusTag {...view.tag} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{view.description}</p>

      {view.steps.length ? (
        <ol
          className="mt-3 flex flex-col gap-1.5"
          aria-label={`Steps of ${view.title}`}
        >
          {view.steps.map((step, index) => (
            <li key={step.format} className="flex items-baseline gap-2 text-xs">
              <span className="w-4 shrink-0 text-muted-foreground">
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
          className="mt-3 flex flex-col gap-1.5 rounded-md bg-white/[0.03] px-3 py-2 text-xs"
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
                    {step.report.map((line, index) => (
                      <li key={`${step.format}-${index}`}>{line}</li>
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
            {view.blocked.body}
          </InlineAlert>
        </div>
      ) : view.note ? (
        <p className="mt-3 text-xs text-muted-foreground">{view.note}</p>
      ) : null}
      {view.waiting ? (
        <p className="mt-3 text-xs text-muted-foreground">{view.waiting}</p>
      ) : null}
      {view.checkResult ? (
        <p className="mt-3 text-xs text-muted-foreground">{view.checkResult}</p>
      ) : null}
      {view.spend ? (
        <p className="mt-3 text-xs text-muted-foreground tabular-nums">
          {view.spend}.
        </p>
      ) : null}

      {view.failure ? (
        <div className="mt-3">
          <InlineAlert
            variant="error"
            title="The upgrade failed"
            actions={
              view.failure.connectorsHref ||
              (view.failure.fixPrompt && fixWithAgent) ? (
                <>
                  {view.failure.connectorsHref ? (
                    <TextLink
                      href={view.failure.connectorsHref}
                      className="text-xs"
                    >
                      {view.failure.connectorsLabel}
                    </TextLink>
                  ) : null}
                  {view.failure.fixPrompt && fixWithAgent ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onPress={() =>
                        view.failure?.fixPrompt &&
                        fixWithAgent(view.failure.fixPrompt)
                      }
                    >
                      Fix using agent
                    </Button>
                  ) : null}
                </>
              ) : undefined
            }
          >
            {view.failure.step ? (
              <p>Failed step: {view.failure.step}.</p>
            ) : null}
            <p className={view.failure.step ? "mt-1" : undefined}>
              {view.failure.reason}
            </p>
            <p className="mt-1 text-xs break-words text-red-100/80">
              Details: {view.failure.summary}
            </p>
            <p className="mt-1">{view.failure.action}</p>
            {view.failure.autoRetried ? (
              <p className="mt-1">
                ctxpipe already started this upgrade again once by itself.
              </p>
            ) : null}
          </InlineAlert>
        </div>
      ) : view.failureReason ? (
        <div className="mt-3">
          <InlineAlert variant="error" title="The upgrade failed">
            {view.failureReason}
          </InlineAlert>
        </div>
      ) : null}

      {view.pullRequest && !openPullRequest ? (
        <TextLink
          href={view.pullRequest.url}
          target="_blank"
          rel="noreferrer"
          variant="secondary"
          className="mt-3 inline-flex items-center gap-1.5 text-xs"
        >
          <IconGitPullRequest className="size-4" aria-hidden />
          {view.pullRequest.number
            ? `Pull request #${view.pullRequest.number}`
            : "Pull request"}
        </TextLink>
      ) : null}

      {openPullRequest || view.canCheck || view.canStart || view.memberAsk ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {openPullRequest && view.pullRequest ? (
            <Button
              variant="primary"
              size="sm"
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
          {view.canCheck ? (
            <Button
              variant="secondary"
              size="sm"
              isPending={view.checking}
              onPress={view.check}
              aria-label={`Check again: ${view.title}`}
            >
              Check again
            </Button>
          ) : view.canStart ? (
            <Button
              variant="primary"
              size="sm"
              isPending={view.starting}
              onPress={view.start}
              aria-label={`${view.startLabel}: ${view.title}`}
            >
              {view.startLabel}
            </Button>
          ) : view.memberAsk ? (
            <p className="text-xs text-muted-foreground">{view.memberAsk}</p>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

type EditField = "name" | "slug"

/** The settings: each row shows its value and opens its own small dialog. */
function SettingsColumn(props: { model: SettingsModel }) {
  const { model } = props
  const { general, repository, workspace } = model
  const [editing, setEditing] = useState<EditField | null>(null)
  // Close the dialog only after a successful save. A failed save keeps it
  // open; the toast gives the reason.
  const save = () =>
    general.saveAsync().then(
      () => setEditing(null),
      () => undefined,
    )
  const open = (field: EditField) => {
    general.reset()
    setEditing(field)
  }
  const close = () => {
    setEditing(null)
    general.reset()
  }

  return (
    <div className="flex max-w-2xl flex-col gap-10">
      <section aria-labelledby="settings-general">
        <h2 id="settings-general" className="ctx-label text-muted-foreground">
          General
        </h2>
        <dl className="mt-3 flex flex-col">
          <SettingRow
            label="Name"
            action={
              <Button
                variant="secondary"
                size="sm"
                aria-label="Edit name"
                onPress={() => open("name")}
              >
                Edit
              </Button>
            }
          >
            <span className="text-foreground">{workspace.displayName}</span>
          </SettingRow>
          <SettingRow
            label="URL name"
            action={
              <Button
                variant="secondary"
                size="sm"
                aria-label="Edit URL name"
                onPress={() => open("slug")}
              >
                Edit
              </Button>
            }
          >
            <code className="font-mono text-xs text-foreground">
              {workspace.slug}
            </code>
          </SettingRow>
          <SettingRow
            label="Repository"
            action={
              <Button
                variant="secondary"
                size="sm"
                aria-label="Change repository or root folder"
                onPress={repository.openRelink}
              >
                Change
              </Button>
            }
          >
            {repository.webUrl ? (
              <TextLink
                href={repository.webUrl}
                target="_blank"
                rel="noreferrer"
                variant="secondary"
                className="inline-flex max-w-full items-center gap-1 no-underline hover:underline"
              >
                <span className="truncate">{repository.title}</span>
                <IconExternalLink
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              </TextLink>
            ) : (
              <span className="block truncate font-mono text-xs text-foreground">
                {repository.url}
              </span>
            )}
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {repository.rootPath ? (
                <>
                  Root folder{" "}
                  <code className="font-mono text-foreground">
                    {repository.rootPath}/
                  </code>
                </>
              ) : (
                "Root folder: the whole repository"
              )}
            </span>
          </SettingRow>
        </dl>
      </section>

      <section aria-label="Sources">
        <p className="ctx-label mb-4 text-muted-foreground">Sources</p>
        <WorkspaceSources
          orgSlug={model.orgSlug}
          workspaceSlug={workspace.slug}
          linkedRepositories={repository.linkedRepositories}
        />
      </section>

      <section aria-labelledby="settings-danger">
        <h2 id="settings-danger" className="ctx-label text-muted-foreground">
          Danger zone
        </h2>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-4 rounded-md border border-white/[0.06] px-4 py-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">
              Delete this Workspace
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Deletes this Workspace and its conversations. Your GitHub
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
      </section>

      <EditDialog
        isOpen={editing === "name"}
        title="Name"
        saving={general.saving}
        dirty={general.dirty}
        onCancel={close}
        onSave={save}
      >
        <TextField
          label="Name"
          value={general.displayName}
          onChange={general.setDisplayName}
          description="Shown in the sidebar and to your team."
          autoFocus
        />
      </EditDialog>
      <EditDialog
        isOpen={editing === "slug"}
        title="URL name"
        saving={general.saving}
        dirty={general.dirty}
        onCancel={close}
        onSave={save}
      >
        <TextField
          label="URL name"
          value={general.slug}
          onChange={general.setSlug}
          description="Used in the web address of this Workspace."
          autoFocus
        />
        <div className="mt-4">
          <InlineAlert variant="warning">
            If you change the URL name, old links stop working.
          </InlineAlert>
        </div>
      </EditDialog>
    </div>
  )
}

function SettingRow(props: {
  label: string
  action: ReactNode
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-start gap-x-4 border-t border-white/[0.06] py-3 first:border-t-0 @xl:grid-cols-[9rem_minmax(0,1fr)_auto]">
      <dt className="pt-1 text-sm text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 pt-1 text-sm">{props.children}</dd>
      <dd>{props.action}</dd>
    </div>
  )
}

/** A small dialog for one setting, with its own Save. */
function EditDialog(props: {
  isOpen: boolean
  title: string
  saving: boolean
  dirty: boolean
  onCancel: () => void
  onSave: () => void
  children: ReactNode
}) {
  return (
    <Modal
      isOpen={props.isOpen}
      onOpenChange={(isOpen) => {
        if (!isOpen) props.onCancel()
      }}
      isDismissable={!props.saving}
    >
      <Dialog>
        <Heading
          slot="title"
          className="my-0 text-lg font-medium leading-6 text-foreground"
        >
          {props.title}
        </Heading>
        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (props.dirty && !props.saving) props.onSave()
          }}
        >
          {props.children}
          <div className="mt-6 flex justify-end gap-2">
            <Button
              type="button"
              variant="quiet"
              isDisabled={props.saving}
              onPress={props.onCancel}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              isPending={props.saving}
              isDisabled={!props.dirty}
            >
              Save
            </Button>
          </div>
        </form>
      </Dialog>
    </Modal>
  )
}
