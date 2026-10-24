import {
  IconAlertTriangle,
  IconArrowRight,
  IconGitPullRequest,
} from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import {
  Disclosure,
  DisclosureHeader,
  DisclosurePanel,
} from "@/components/ui/Disclosure"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Link as TextLink } from "@/components/ui/Link"
import {
  Skeleton,
  SkeletonText,
  useSkeletonHold,
} from "@/components/ui/Skeleton"
import { StatusTag } from "@/features/workspaces/StatusTag"
import { useIsOrgAdmin } from "@/lib/org-member-role"
import { AutomaticUpgradesToggle } from "./AutomaticUpgradesToggle"
import { useExpiredCheckingKeys } from "./checking-format-clock"
import {
  checkWorkspaceUpgradesAndWait,
  type WorkspaceUpgradeItem,
  type WorkspaceUpgrades as WorkspaceUpgradesData,
  workspaceUpgradeKeys,
  workspaceUpgradesOptions,
} from "./queries"
import { UpgradeRunProgress } from "./UpgradeRunProgress"
import {
  CHECKING_FORMAT_COPY,
  formatHealthLine,
  MEMBER_ASK_ADMIN,
  STATUS_INTRO,
  UPGRADE_WAITS_TAG,
  upgradeBlockedCopy,
  upgradeCanCheck,
  upgradeCanStart,
  upgradeGroups,
  upgradeHeadline,
  upgradeHistoryLine,
  upgradeIsCheckingFormat,
  upgradeNotices,
  upgradeSpendLine,
  upgradeStatusTag,
  upgradeWaitingCopy,
} from "./upgrade-copy"
import {
  type UpgradeFailure,
  upgradeFailureAllowsStartAgain,
  upgradeFailureCopy,
  upgradeFailurePrompt,
} from "./upgrade-failure"
import { upgradeCheckResult, upgradeProgress } from "./upgrade-progress"
import { useStartWorkspaceUpgrade } from "./use-start-upgrade"

type UpgradeGroup = "needs_you" | "working" | "done"

/**
 * One upgrade. `isAdmin` is `null` while the role loads: no action shows.
 * The card shows no cost or time estimate: the p50 to p90 range was too
 * wide to help (CTX-894). The description says that a re-ingestion costs
 * money. The Status group gives the group and the checking clock, so the
 * card and the headline always agree.
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
  /** The org of the item: the failure card links to its connectors. */
  orgSlug?: string
  workspaceSlug?: string
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
  const notices = upgradeNotices(item)
  const progress = upgradeProgress(item)
  const checkResult = upgradeCheckResult(item, props.formatVersion)
  const stepsWithReport = item.steps.filter((step) => step.report.length > 0)
  const spend = upgradeSpendLine(item)
  return (
    <li
      className="rounded-md border border-white/[0.06] px-4 py-3"
      aria-label={item.title}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-foreground">{item.title}</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {item.kind === "reingest"
              ? item.description
              : `${item.description} Format ${item.fromFormat} to format ${item.targetFormat}. ctxpipe opens one pull request. Nothing changes until you merge it.`}
          </p>
        </div>
        <StatusTag
          {...(blockedWaits
            ? UPGRADE_WAITS_TAG
            : upgradeStatusTag(item, formatVersion))}
        />
      </div>

      {item.steps.length > 0 ? (
        <ol
          className="mt-3 flex flex-col gap-1.5"
          aria-label={`Steps of ${item.title}`}
        >
          {item.steps.map((step, index) => (
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

      {progress ? (
        <UpgradeRunProgress title={item.title} progress={progress} />
      ) : null}

      {notices.length > 0 ? (
        <div className="mt-3 rounded-md bg-white/[0.03] px-3 py-2">
          <p className="text-xs font-medium text-foreground">Notes</p>
          <ul
            className="mt-1.5 flex flex-col gap-1.5 text-xs"
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
        </div>
      ) : null}

      {stepsWithReport.length > 0 ? (
        <Disclosure className="mt-2 -mx-2">
          <DisclosureHeader>
            <span className="text-xs text-muted-foreground">Details</span>
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

      {checkingFormat || blockedWaits ? null : item.status === "blocked" ? (
        <div className="mt-3">
          <InlineAlert variant="warning" title={upgradeBlockedCopy(item).title}>
            <p>{upgradeBlockedCopy(item).body}</p>
          </InlineAlert>
        </div>
      ) : item.note ? (
        <p className="mt-3 text-xs text-muted-foreground">{item.note}</p>
      ) : null}

      {waiting ? (
        <p className="mt-3 text-xs text-muted-foreground">{waiting}</p>
      ) : null}

      {checkResult ? (
        <p className="mt-3 text-xs text-muted-foreground">{checkResult}</p>
      ) : null}

      {spend ? (
        <p className="mt-3 text-xs text-muted-foreground">{spend}.</p>
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

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        {item.pullRequest ? (
          <TextLink
            href={item.pullRequest.url}
            target="_blank"
            rel="noreferrer"
            variant="secondary"
            className="inline-flex items-center gap-1.5 text-xs"
          >
            <IconGitPullRequest className="size-4" aria-hidden />
            {item.pullRequest.number
              ? `Pull request #${item.pullRequest.number}`
              : "Pull request"}
          </TextLink>
        ) : (
          <span />
        )}
        {upgradeCanCheck(item) && isAdmin === true && onCheck ? (
          <Button
            variant="secondary"
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
            isPending={isStarting}
            onPress={onStart}
            aria-label={`${item.status === "failed" ? "Start again" : "Start"}: ${item.title}`}
          >
            {item.status === "failed" ? "Start again" : "Start"}
          </Button>
        ) : (upgradeCanStart(item) ||
            (item.status === "blocked" && upgradeCanCheck(item))) &&
          isAdmin === false ? (
          <p className="text-xs text-muted-foreground">{MEMBER_ASK_ADMIN}</p>
        ) : null}
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
  // One mutation for each card: the pending state of one card stays apart.
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
      workspaceSlug={workspaceSlug}
      onFixWithAgent={props.onFixWithAgent}
    />
  )
}

/**
 * The loading state of the Status group. It has the box of the Up to date
 * state: the headline row and the format row (DESIGN.md Loading, Match).
 */
function UpgradesSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <span className="sr-only">Loading upgrades</span>
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-5.5 w-24" />
        <SkeletonText className="text-sm" boneClassName="w-80" />
      </div>
      <div className="flex min-h-7 items-center">
        <SkeletonText className="text-xs" boneClassName="w-56" />
      </div>
    </div>
  )
}

/** One list of the Status group: Needs you or Working now. */
function UpgradeItemList(props: {
  label: string
  items: WorkspaceUpgradeItem[]
  row: (item: WorkspaceUpgradeItem) => ReactNode
}) {
  if (props.items.length === 0) return null
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{props.label}</p>
      <ul className="mt-2 flex flex-col gap-3" aria-label={props.label}>
        {props.items.map(props.row)}
      </ul>
    </div>
  )
}

/**
 * The Status group of Workspace settings (CTX-980). Its first line says if the
 * user must act: Needs you, Working (no action needed), or Up to date.
 */
export function WorkspaceUpgrades(props: {
  orgSlug: string
  workspaceSlug: string
  /** Opens the chat with a prompt: the "Fix using agent" action of a failed item. */
  onFixWithAgent?: (prompt: string) => void
}) {
  const { orgSlug, workspaceSlug } = props
  const upgradesQuery = useQuery(
    workspaceUpgradesOptions(orgSlug, workspaceSlug),
  )
  const loading = useSkeletonHold(upgradesQuery.isPending)
  const isAdmin = useIsOrgAdmin(orgSlug)
  const data = upgradesQuery.data
  const formatVersion = data?.formatVersion ?? null
  const items = data?.items ?? []
  // One clock for the group: a checking state older than a minute needs you.
  const expired = useExpiredCheckingKeys(
    `${orgSlug}/${workspaceSlug}`,
    items,
    formatVersion,
  )
  const { lists, groupOf, count } = upgradeGroups(items, formatVersion, expired)
  const headline =
    data &&
    upgradeHeadline({ count, formatVersion, codeFormat: data.codeFormat })
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
    <section aria-labelledby="workspace-upgrades">
      {/* The settings group eyebrow names this section on screen. */}
      <h2 id="workspace-upgrades" className="sr-only">
        Status
      </h2>
      {loading ? (
        <UpgradesSkeleton />
      ) : upgradesQuery.isError ? (
        <InlineAlert
          variant="error"
          actions={
            <Button
              variant="secondary"
              onPress={() => void upgradesQuery.refetch()}
            >
              Try again
            </Button>
          }
        >
          Could not load the upgrades.
        </InlineAlert>
      ) : data && headline ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-3">
              <StatusTag {...headline} />
              <p className="text-sm text-foreground">{headline.line}</p>
            </div>
            {count.needs_you + count.working > 0 ? (
              <p className="text-xs text-muted-foreground">{STATUS_INTRO}</p>
            ) : null}
          </div>
          <UpgradeItemList
            label="Needs you"
            items={lists.needs_you}
            row={row}
          />
          <UpgradeItemList
            label="Working now"
            items={lists.working}
            row={row}
          />
          <div className="flex min-h-7 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span>{formatHealthLine(data.formatVersion, data.codeFormat)}</span>
            <AutomaticUpgradesToggle
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              isAdmin={isAdmin}
            />
          </div>
          {lists.done.length > 0 ? (
            <Disclosure className="-mx-2">
              <DisclosureHeader>
                <span className="text-xs text-muted-foreground">
                  {upgradeHistoryLine(lists.done)}
                </span>
              </DisclosureHeader>
              <DisclosurePanel className="px-2">
                <ul
                  className="flex flex-col gap-3 pt-1"
                  aria-label="Applied upgrades"
                >
                  {lists.done.map(row)}
                </ul>
              </DisclosurePanel>
            </Disclosure>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
