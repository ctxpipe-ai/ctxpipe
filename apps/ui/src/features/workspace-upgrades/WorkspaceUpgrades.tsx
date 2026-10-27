import {
  IconAlertTriangle,
  IconArrowRight,
  IconChevronRight,
  IconGitPullRequest,
  IconInfoCircle,
} from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Fragment, useState } from "react"
import {
  Button as AriaButton,
  Disclosure as AriaDisclosure,
  DisclosurePanel as AriaDisclosurePanel,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip"
import { SettingsCard } from "@/features/workspaces/settings/SettingsCard"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { useIsOrgAdmin } from "@/lib/org-member-role"
import { cn } from "@/lib/utils"

import { AutomaticUpgradesSwitch } from "./AutomaticUpgradesSwitch"
import { useExpiredCheckingKeys } from "./checking-format-clock"
import {
  checkWorkspaceUpgradesAndWait,
  type WorkspaceUpgradeItem,
  type WorkspaceUpgrades as WorkspaceUpgradesData,
  workspaceUpgradeKeys,
  workspaceUpgradesOptions,
} from "./queries"
import {
  CHECKING_FORMAT_COPY,
  formatHealthLine,
  MEMBER_ASK_ADMIN,
  UPGRADE_WAITS_LABEL,
  upgradeBlockedCopy,
  upgradeCanCheck,
  upgradeCanStart,
  upgradeGroups,
  upgradeHistoryLine,
  upgradeIsCheckingFormat,
  upgradeNotices,
  upgradeSpendLine,
  upgradeStatusLabel,
  upgradeWaitingCopy,
  upgradesState,
} from "./upgrade-copy"
import {
  type UpgradeFailure,
  upgradeFailureAllowsStartAgain,
  upgradeFailureCopy,
  upgradeFailurePrompt,
} from "./upgrade-failure"
import { upgradeCheckResult, upgradeProgress } from "./upgrade-progress"
import { UpgradeRunProgress } from "./UpgradeRunProgress"
import { useStartWorkspaceUpgrade } from "./use-start-upgrade"

type UpgradeGroup = "needs_you" | "working" | "done"

/**
 * The upgrades of one Workspace, in the groups of the card. The card and the
 * summary of Workspace settings both read it: the one query and the one
 * checking clock, so they always agree.
 */
function useUpgradeGroups(orgSlug: string, workspaceSlug: string) {
  const query = useQuery(workspaceUpgradesOptions(orgSlug, workspaceSlug))
  const data = query.data
  const formatVersion = data?.formatVersion ?? null
  const items = data?.items ?? []
  // One clock: a checking state older than a minute needs the user.
  const expired = useExpiredCheckingKeys(
    `${orgSlug}/${workspaceSlug}`,
    items,
    formatVersion,
  )
  const groups = upgradeGroups(items, formatVersion, expired)
  // Sources show their own work, so the ingestion does not count here.
  const state = data
    ? upgradesState({
        count: groups.count,
        formatVersion,
        codeFormat: data.codeFormat,
      })
    : null
  return {
    query,
    data,
    formatVersion,
    expired,
    state,
    needsYou: query.isError || state === "needs_you",
    working: state === "working" || state === "checking_format",
    ...groups,
  }
}

/**
 * The state of the upgrades for the summary of Workspace settings: do they
 * need the user, and does ctxpipe work on them now.
 */
export function useUpgradesStatus(orgSlug: string, workspaceSlug: string) {
  const { query, needsYou, working } = useUpgradeGroups(orgSlug, workspaceSlug)
  return { loading: query.isPending, needsYou, working }
}

/** The dot of an upgrade row: the kind of attention that it wants. */
function upgradeDot(item: WorkspaceUpgradeItem, group: UpgradeGroup) {
  if (item.status === "failed")
    return { className: "bg-red-400", label: "Failed" }
  if (group === "needs_you")
    return { className: "bg-amber-400", label: "Needs you" }
  return { className: "ctx-status-pulse bg-teal-400", label: "Working" }
}

/** A format item says what it changes, and that a merge applies it. */
function upgradeDescription(item: WorkspaceUpgradeItem): string {
  return item.kind === "reingest"
    ? item.description
    : `${item.description} Format ${item.fromFormat} to format ${item.targetFormat}. ctxpipe opens one pull request. Nothing changes until you merge it.`
}

/**
 * Facts in one muted line. Each fact is its own element and the dots are
 * hidden, so a screen reader reads each fact apart.
 */
function FactLine(props: { facts: string[] }) {
  return props.facts.map((fact, index) => (
    <Fragment key={fact}>
      {index > 0 ? <span aria-hidden> · </span> : null}
      <span>{fact}</span>
    </Fragment>
  ))
}

function PullRequestLink(props: {
  pullRequest: NonNullable<WorkspaceUpgradeItem["pullRequest"]>
  /** Only the number, for a history row. */
  short?: boolean
}) {
  const { pullRequest } = props
  return (
    <TextLink
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs"
    >
      <IconGitPullRequest className="size-3.5" aria-hidden />
      {pullRequest.number
        ? props.short
          ? `#${pullRequest.number}`
          : `Pull request #${pullRequest.number}`
        : "Pull request"}
    </TextLink>
  )
}

/**
 * The detail of an upgrade: its steps, its run, its notes, the step reports,
 * and a block or a failure. An open row and an opened history row show it.
 */
function UpgradeDetail(props: {
  item: WorkspaceUpgradeItem
  /** The checking state shows no block: ctxpipe reads the new format. */
  showBlocked: boolean
  orgSlug?: string | undefined
  onFixWithAgent?: ((prompt: string) => void) | undefined
}) {
  const { item } = props
  const notices = upgradeNotices(item)
  const progress = upgradeProgress(item)
  const stepsWithReport = item.steps.filter((step) => step.report.length > 0)
  return (
    <>
      {item.steps.length > 0 ? (
        <ol
          className="mt-3 flex flex-col gap-1"
          aria-label={`Steps of ${item.title}`}
        >
          {item.steps.map((step, index) => (
            <li
              key={step.format}
              className="flex items-baseline gap-2 text-xs text-muted-foreground"
            >
              <span className="w-3 shrink-0 tabular-nums">{index + 1}</span>
              <span>{step.title}</span>
              {step.commitSha ? (
                <code className="font-mono">{step.commitSha.slice(0, 7)}</code>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {progress ? (
        <UpgradeRunProgress title={item.title} progress={progress} />
      ) : null}

      {notices.length > 0 ? (
        <ul
          className="mt-3 flex flex-col gap-1.5 text-xs"
          aria-label={`Notes of ${item.title}`}
        >
          {notices.map((notice) => (
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

      {stepsWithReport.length > 0 ? (
        <Disclosure className="mt-2 -mx-2">
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

      {props.showBlocked && item.status === "blocked" ? (
        <div className="mt-3">
          <InlineAlert variant="warning" title={upgradeBlockedCopy(item).title}>
            <p>{upgradeBlockedCopy(item).body}</p>
          </InlineAlert>
        </div>
      ) : null}

      {item.status === "failed" ? (
        <div className="mt-3">
          {item.failure ? (
            <UpgradeFailureAlert
              item={item}
              failure={item.failure}
              orgSlug={props.orgSlug}
              onFixWithAgent={props.onFixWithAgent}
            />
          ) : (
            <InlineAlert variant="error" title="The upgrade failed">
              <p>{item.failureReason ?? "ctxpipe gives no reason."}</p>
            </InlineAlert>
          )}
        </div>
      ) : null}
    </>
  )
}

/**
 * One upgrade that needs the user or runs now: a row with a dot, its facts
 * in one muted line, and its action on the right of the title. `isAdmin` is
 * `null` while the role loads: no action shows. The row shows no cost or
 * time estimate: the p50 to p90 range was too wide to help (CTX-894). The
 * description says that a re-ingestion costs money.
 */
function UpgradeItemCard(props: {
  item: WorkspaceUpgradeItem
  /** The format that ctxpipe read last: a re-ingestion that needs it can be stale. */
  formatVersion: number | null
  group: UpgradeGroup
  /** The checking state of this item is older than a minute: it is blocked again. */
  checkingExpired: boolean
  isAdmin: boolean | null
  onStart: () => void
  onCheck?: () => void
  isStarting?: boolean
  isChecking?: boolean
  /** The org of the item: the failure alert links to its connectors. */
  orgSlug?: string
  /** Opens the chat with this prompt ("Fix using agent"). */
  onFixWithAgent?: ((prompt: string) => void) | undefined
}) {
  const { item, isAdmin, onStart, onCheck, isStarting, isChecking } = props
  // After a minute, the checking state ends and the blocked line comes back.
  const formatVersion = props.checkingExpired ? null : props.formatVersion
  const checkingFormat = upgradeIsCheckingFormat(item, formatVersion)
  const working = props.group === "working"
  // A blocked item in Working now waits for ctxpipe, not for a person.
  const blockedWaits = working && item.status === "blocked" && !checkingFormat
  const waiting = checkingFormat
    ? CHECKING_FORMAT_COPY
    : blockedWaits
      ? item.blockedReason === "needs_format"
        ? "This starts after ctxpipe reads the format upgrade above."
        : upgradeBlockedCopy(item).body
      : upgradeWaitingCopy(item)
  const status = blockedWaits
    ? UPGRADE_WAITS_LABEL
    : upgradeStatusLabel(item, formatVersion)
  const spend = upgradeSpendLine(item)
  const dot = upgradeDot(item, props.group)
  // One muted line of facts. A waiting item has its Start button (or "Ask an
  // admin"), so its tag does not repeat it.
  const meta = [
    item.status === "awaiting_operator" ? null : status,
    checkingFormat || blockedWaits || item.status === "blocked"
      ? null
      : item.note,
    waiting,
    upgradeCheckResult(item, props.formatVersion),
    spend,
  ].filter((line): line is string => Boolean(line))
  const action =
    upgradeCanCheck(item) && isAdmin === true && onCheck ? (
      <Button
        variant="secondary"
        size="sm"
        isPending={isChecking}
        onPress={onCheck}
        aria-label={`Check again: ${item.title}`}
      >
        Check again
      </Button>
    ) : upgradeCanStart(item) &&
      isAdmin === true &&
      upgradeFailureAllowsStartAgain(item) ? (
      <Button
        variant="primary"
        size="sm"
        isPending={isStarting}
        onPress={onStart}
        aria-label={`${item.status === "failed" ? "Start again" : "Start"}: ${item.title}`}
      >
        {item.status === "failed" ? "Start again" : "Start"}
      </Button>
    ) : (upgradeCanStart(item) ||
        (item.status === "blocked" && upgradeCanCheck(item))) &&
      isAdmin === false ? (
      <p className="pt-1 text-xs text-muted-foreground">{MEMBER_ASK_ADMIN}</p>
    ) : null
  return (
    <li className="px-5 py-4" aria-label={item.title}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm text-foreground">
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", dot.className)}
            />
            <span className="sr-only">{dot.label}: </span>
            {item.title}
          </h3>
          <div className="pl-3.5">
            <p className="mt-1 max-w-prose text-xs text-muted-foreground">
              {upgradeDescription(item)}
            </p>
            {meta.length ? (
              <p className="mt-1.5 max-w-prose text-xs text-muted-foreground">
                <FactLine facts={meta} />
              </p>
            ) : null}
            {item.pullRequest ? (
              <p className="mt-1.5">
                <PullRequestLink pullRequest={item.pullRequest} />
              </p>
            ) : null}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="pl-3.5">
        <UpgradeDetail
          item={item}
          showBlocked={!checkingFormat && !blockedWaits}
          orgSlug={props.orgSlug}
          onFixWithAgent={props.onFixWithAgent}
        />
      </div>
    </li>
  )
}

/** A failed item: the step that failed, why, and the fix (CTX-895). */
function UpgradeFailureAlert(props: {
  item: WorkspaceUpgradeItem
  failure: UpgradeFailure
  orgSlug: string | undefined
  onFixWithAgent: ((prompt: string) => void) | undefined
}) {
  const { item, failure, orgSlug, onFixWithAgent } = props
  const copy = upgradeFailureCopy(failure)
  const link =
    copy.link === "connectors" && orgSlug ? (
      <TextLink href={`/${orgSlug}/connectors`} className="text-xs">
        {copy.linkLabel}
      </TextLink>
    ) : null
  const agent =
    copy.agent && onFixWithAgent ? (
      <Button
        variant="secondary"
        onPress={() => onFixWithAgent(upgradeFailurePrompt(item, failure))}
      >
        Fix using agent
      </Button>
    ) : null
  return (
    <InlineAlert
      variant="error"
      title="The upgrade failed"
      actions={
        link || agent ? (
          <>
            {link}
            {agent}
          </>
        ) : undefined
      }
    >
      {copy.step ? <p>Failed step: {copy.step}.</p> : null}
      <p className={copy.step ? "mt-1" : undefined}>{copy.reason}</p>
      <p className="mt-1 text-xs break-words opacity-80">
        Details: {failure.summary}
      </p>
      <p className="mt-1">{copy.action}</p>
      {item.autoRetried ? (
        <p className="mt-1">
          ctxpipe already started this upgrade again once by itself.
        </p>
      ) : null}
    </InlineAlert>
  )
}

function UpgradeItemRow(props: {
  item: WorkspaceUpgradeItem
  formatVersion: number | null
  group: UpgradeGroup
  checkingExpired: boolean
  orgSlug: string
  workspaceSlug: string
  isAdmin: boolean | null
  onFixWithAgent: ((prompt: string) => void) | undefined
}) {
  const { item, orgSlug, workspaceSlug, isAdmin } = props
  const queryClient = useQueryClient()
  // One mutation for each row: the pending state of one row stays apart.
  const startMutation = useStartWorkspaceUpgrade(orgSlug, workspaceSlug, item)
  const checkMutation = useMutation({
    mutationFn: () =>
      checkWorkspaceUpgradesAndWait(
        queryClient,
        orgSlug,
        workspaceSlug,
        item.key,
      ),
    onSuccess: (result) => {
      if (result === "pending") {
        toast.message(
          "ctxpipe has not finished the check yet. This page shows the result when it does.",
        )
        return
      }
      const found = queryClient
        .getQueryData<WorkspaceUpgradesData>(
          workspaceUpgradeKeys.list(orgSlug, workspaceSlug),
        )
        ?.items.find(({ key }) => key === item.key)
      toast.success(
        (found && upgradeCheckResult(found, props.formatVersion)) ??
          "ctxpipe checked the Workspace. The upgrade is not pending any more.",
      )
    },
    onError: (error: Error) => {
      toast.error(
        `${error.message.replace(/\.$/, "")}. Press Check again to try again.`,
      )
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: workspaceUpgradeKeys.list(orgSlug, workspaceSlug),
        }),
        queryClient.invalidateQueries({
          queryKey: workspaceUpgradeKeys.pending(orgSlug),
        }),
      ]),
  })
  return (
    <UpgradeItemCard
      item={item}
      formatVersion={props.formatVersion}
      group={props.group}
      checkingExpired={props.checkingExpired}
      isAdmin={isAdmin}
      isStarting={startMutation.isPending}
      isChecking={checkMutation.isPending}
      onStart={() => startMutation.mutate()}
      onCheck={() => checkMutation.mutate()}
      orgSlug={orgSlug}
      onFixWithAgent={props.onFixWithAgent}
    />
  )
}

/**
 * The format of the repository in one line, with a tooltip that says what a
 * format is. A format problem (not valid, newer than ctxpipe) shows in amber.
 */
function FormatNote(props: {
  formatVersion: number | null
  codeFormat: number
}) {
  const { formatVersion, codeFormat } = props
  if (formatVersion === null || formatVersion < 0 || formatVersion > codeFormat)
    return (
      <p
        className={cn(
          "max-w-prose text-xs",
          formatVersion === null ? "text-muted-foreground" : "text-amber-200",
        )}
      >
        {formatHealthLine(formatVersion, codeFormat)}
      </p>
    )
  return (
    <p className="flex items-center gap-1 text-xs text-muted-foreground">
      {formatVersion === codeFormat
        ? `Format ${formatVersion}, the latest`
        : `Format ${formatVersion}. The latest is format ${codeFormat}.`}
      <TooltipProvider delay={200}>
        <Tooltip>
          <TooltipTrigger
            aria-label="About the format"
            className={cn(
              "rounded-full p-0.5 text-muted-foreground hover:text-foreground",
              focusVisibleClassName,
            )}
          >
            <IconInfoCircle className="size-3.5" aria-hidden />
          </TooltipTrigger>
          <TooltipContent side="top" align="end">
            The format is how ctxpipe arranges the files in the repository of
            this Workspace. When a new format ships, an upgrade moves the files
            in a pull request.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </p>
  )
}

const HISTORY_SHOWN = 5

/**
 * An applied upgrade: the date, the title, and its pull request or spend. It
 * opens to what the row showed when the upgrade ran.
 */
function HistoryRow(props: {
  item: WorkspaceUpgradeItem
  formatVersion: number | null
}) {
  const { item } = props
  const spend = upgradeSpendLine(item)
  const meta = [
    upgradeCheckResult(item, props.formatVersion),
    item.note,
    spend,
  ].filter((line): line is string => Boolean(line))
  return (
    <li className="text-xs" aria-label={item.title}>
      <AriaDisclosure>
        {({ isExpanded }) => (
          <>
            <div className="flex items-center gap-3 py-1">
              <AriaButton
                slot="trigger"
                className={cn(
                  "grid min-w-0 flex-1 grid-cols-[1rem_3.5rem_minmax(0,1fr)] items-center gap-x-2 rounded-md py-1 text-left",
                  focusVisibleClassName,
                )}
              >
                <IconChevronRight
                  aria-hidden
                  className={cn(
                    "size-3.5 text-muted-foreground transition-transform",
                    isExpanded && "rotate-90",
                  )}
                />
                <span className="text-muted-foreground tabular-nums">
                  {/* One zone, as the history line: the same day for each user. */}
                  {new Date(item.updatedAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    timeZone: "UTC",
                  })}
                </span>
                <span className="truncate text-foreground">{item.title}</span>
              </AriaButton>
              <span className="shrink-0 text-muted-foreground">
                {item.pullRequest ? (
                  <PullRequestLink pullRequest={item.pullRequest} short />
                ) : spend ? (
                  // "Spend: at least $4.13" shows as "at least $4.13".
                  spend.replace(/^Spend( so far)?: /, "")
                ) : null}
              </span>
            </div>
            <AriaDisclosurePanel>
              <div className="pb-3 pl-6.5">
                <p className="max-w-prose text-muted-foreground">
                  {upgradeDescription(item)}
                </p>
                {meta.length ? (
                  <p className="mt-1.5 max-w-prose text-muted-foreground">
                    <FactLine facts={meta} />
                  </p>
                ) : null}
                <UpgradeDetail item={item} showBlocked={false} />
              </div>
            </AriaDisclosurePanel>
          </>
        )}
      </AriaDisclosure>
    </li>
  )
}

/**
 * The applied upgrades, newest first. Five show; the rest open in a scroll
 * area, so a long history keeps the card short.
 */
function UpgradeHistory(props: {
  items: WorkspaceUpgradeItem[]
  formatVersion: number | null
}) {
  const [all, setAll] = useState(false)
  const sorted = [...props.items].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )
  const shown = all ? sorted : sorted.slice(0, HISTORY_SHOWN)
  return (
    <Disclosure className="px-3 py-1">
      <DisclosureHeader>
        <span className="text-xs font-normal text-muted-foreground">
          {upgradeHistoryLine(sorted)}
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
          {shown.map((item) => (
            <HistoryRow
              key={item.key}
              item={item}
              formatVersion={props.formatVersion}
            />
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

/**
 * The Upgrades card of Workspace settings (CTX-980). Each upgrade that needs
 * the user or runs now is a row with a dot and its action. Under them: the
 * automatic-upgrades switch, the format, and the history. The header says
 * "Up to date" only when no row shows and the format is the latest.
 */
export function WorkspaceUpgrades(props: {
  orgSlug: string
  workspaceSlug: string
  /** A link landed on the card (#upgrades). */
  landing?: boolean
  /** Opens the chat with a prompt: the "Fix using agent" action of a failed item. */
  onFixWithAgent?: (prompt: string) => void
}) {
  const { orgSlug, workspaceSlug } = props
  const upgrades = useUpgradeGroups(orgSlug, workspaceSlug)
  const { query, data, formatVersion, expired, lists, groupOf } = upgrades
  const loading = useSkeletonHold(query.isPending)
  const isAdmin = useIsOrgAdmin(orgSlug)
  const needsYou = !loading && upgrades.needsYou
  // The rows say "needs you" and "working". The header says what they do not.
  const status =
    loading || upgrades.state === null
      ? null
      : upgrades.state === "checking_format"
        ? "Checking the format"
        : upgrades.state === "up_to_date"
          ? "Up to date"
          : null
  const row = (item: WorkspaceUpgradeItem) => (
    <UpgradeItemRow
      key={item.key}
      item={item}
      formatVersion={formatVersion}
      group={groupOf.get(item.key) ?? "needs_you"}
      checkingExpired={expired.has(item.key)}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      isAdmin={isAdmin}
      onFixWithAgent={props.onFixWithAgent}
    />
  )

  return (
    <SettingsCard
      part="upgrades"
      description="ctxpipe keeps this Workspace current."
      status={status}
      needsYou={needsYou}
      landing={props.landing ?? false}
    >
      {loading ? (
        // The box of the loaded "Up to date" card: the switch with its help
        // line, and the format line, which wraps under them on a narrow card
        // (DESIGN.md Loading, Match).
        <div
          className="-mx-5 -mb-4 flex flex-wrap items-start justify-between gap-x-8 gap-y-3 border-t border-white/[0.06] px-5 py-3"
          aria-busy
        >
          <span className="sr-only">Loading upgrades</span>
          <div className="flex min-w-0 basis-120 flex-col gap-1">
            <SkeletonText className="text-sm" boneClassName="w-44" />
            <SkeletonText className="text-xs" boneClassName="w-72" />
          </div>
          <div className="flex min-h-4.5 items-center">
            <SkeletonText className="text-xs" boneClassName="w-36" />
          </div>
        </div>
      ) : query.isError ? (
        <InlineAlert
          variant="error"
          actions={
            <Button variant="secondary" onPress={() => void query.refetch()}>
              Try again
            </Button>
          }
        >
          Could not load the upgrades.
        </InlineAlert>
      ) : data ? (
        // Full-width hairlines between the parts, not boxes.
        <div className="-mx-5 -mb-4 divide-y divide-white/[0.06] border-t border-white/[0.06]">
          {lists.needs_you.length ? (
            <ul className="divide-y divide-white/[0.06]" aria-label="Needs you">
              {lists.needs_you.map(row)}
            </ul>
          ) : null}
          {lists.working.length ? (
            <ul
              className="divide-y divide-white/[0.06]"
              aria-label="Working now"
            >
              {lists.working.map(row)}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3 px-5 py-3">
            <AutomaticUpgradesSwitch
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              isAdmin={isAdmin}
            />
            <FormatNote
              formatVersion={data.formatVersion}
              codeFormat={data.codeFormat}
            />
          </div>
          {lists.done.length > 0 ? (
            <UpgradeHistory items={lists.done} formatVersion={formatVersion} />
          ) : null}
        </div>
      ) : null}
    </SettingsCard>
  )
}
