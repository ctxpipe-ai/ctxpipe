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
import {
  checkWorkspaceUpgrades,
  startWorkspaceUpgrade,
  type WorkspaceUpgradeItem,
  workspaceUpgradeKeys,
  workspaceUpgradesOptions,
} from "./queries"
import {
  formatHealthLine,
  formatUpgradeEstimate,
  MEMBER_ASK_ADMIN,
  UPGRADE_STATUS_TAG,
  upgradeBlockedCopy,
  upgradeBlockedNextStep,
  upgradeCanCheck,
  upgradeCanStart,
  upgradeIsPending,
  upgradeNotices,
  upgradeStartedMessage,
  upgradeWaitingCopy,
} from "./upgrade-copy"
import {
  type UpgradeFailure,
  upgradeFailureCopy,
  upgradeFailurePrompt,
} from "./upgrade-failure"

/**
 * One upgrade. `isAdmin` is `null` while the role loads: no action shows.
 * `estimate` is the slot for the cost estimate of a re-ingestion item
 * (CTX-746). The list fills it from `item.estimate` when the API gives one.
 */
export function UpgradeItemCard(props: {
  item: WorkspaceUpgradeItem
  isAdmin: boolean | null
  onStart: () => void
  onCheck?: () => void
  isStarting?: boolean
  isChecking?: boolean
  estimate?: ReactNode
  /** The org of the item: the failure card links to its connectors. */
  orgSlug?: string
  /** Opens the chat with this prompt ("Fix using agent"). */
  onFixWithAgent?: (prompt: string) => void
}) {
  const { item, isAdmin, onStart, onCheck, isStarting, isChecking, estimate } =
    props
  const waiting = upgradeWaitingCopy(item)
  const blockedNextStep = upgradeBlockedNextStep(item)
  const notices = upgradeNotices(item)
  const stepsWithReport = item.steps.filter((step) => step.report.length > 0)
  return (
    <li
      className="rounded-md border border-white/[0.06] px-4 py-3"
      aria-label={item.title}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">{item.title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {item.kind === "reingest"
              ? "ctx| reads each source repository again and publishes the new knowledge to the Workspace."
              : `Format ${item.fromFormat} to format ${item.targetFormat}. ctx| opens one pull request. Nothing changes until you merge it.`}
          </p>
        </div>
        <StatusTag {...UPGRADE_STATUS_TAG[item.status]} />
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

      {estimate ? (
        <div className="mt-3 text-xs text-muted-foreground">{estimate}</div>
      ) : null}

      {item.status === "blocked" ? (
        <div className="mt-3">
          <InlineAlert variant="warning" title={upgradeBlockedCopy(item).title}>
            <p>{upgradeBlockedCopy(item).body}</p>
            {blockedNextStep ? <p className="mt-1">{blockedNextStep}</p> : null}
          </InlineAlert>
        </div>
      ) : item.note ? (
        <p className="mt-3 text-xs text-muted-foreground">{item.note}</p>
      ) : null}

      {waiting ? (
        <p className="mt-3 text-xs text-muted-foreground">{waiting}</p>
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
              <p>{item.failureReason ?? "ctx| gives no reason."}</p>
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
        ) : upgradeCanStart(item) && isAdmin === true ? (
          <Button
            variant="primary"
            isPending={isStarting}
            onPress={onStart}
            aria-label={`${item.status === "failed" ? "Start again" : "Start"}: ${item.title}`}
          >
            {item.status === "failed" ? "Start again" : "Start"}
          </Button>
        ) : upgradeCanStart(item) && isAdmin === false ? (
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
    </InlineAlert>
  )
}

function UpgradeItemRow(props: {
  item: WorkspaceUpgradeItem
  orgSlug: string
  workspaceSlug: string
  isAdmin: boolean | null
  onFixWithAgent?: (prompt: string) => void
}) {
  const { item, orgSlug, workspaceSlug, isAdmin } = props
  const queryClient = useQueryClient()
  // One mutation for each card: the pending state of one card stays apart.
  const startMutation = useMutation({
    mutationFn: () => startWorkspaceUpgrade(orgSlug, workspaceSlug, item.key),
    onSuccess: () => {
      toast.success(upgradeStartedMessage(item))
    },
    onError: (error: Error) => {
      toast.error(error.message)
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
  const checkMutation = useMutation({
    mutationFn: () => checkWorkspaceUpgrades(orgSlug, workspaceSlug),
    onSuccess: () => {
      toast.success("ctx| is reading the repository now. This takes a minute.")
    },
    onError: (error: Error) => {
      toast.error(error.message)
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
      isAdmin={isAdmin}
      isStarting={startMutation.isPending}
      isChecking={checkMutation.isPending}
      onStart={() => startMutation.mutate()}
      onCheck={() => checkMutation.mutate()}
      estimate={item.estimate ? formatUpgradeEstimate(item.estimate) : null}
      orgSlug={orgSlug}
      {...(props.onFixWithAgent
        ? { onFixWithAgent: props.onFixWithAgent }
        : {})}
    />
  )
}

function UpgradesSkeleton() {
  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-white/[0.06] px-4 py-3"
      aria-busy
    >
      <span className="sr-only">Loading upgrades</span>
      <SkeletonText className="text-sm" boneClassName="h-3.5 w-40" />
      <SkeletonText className="text-xs" boneClassName="w-64" />
      <Skeleton className="h-8 w-24" />
    </div>
  )
}

/** The Upgrades group of Workspace settings. */
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
  const pending = data?.items.filter(upgradeIsPending) ?? []
  const applied = data?.items.filter((item) => !upgradeIsPending(item)) ?? []

  return (
    <section aria-labelledby="workspace-upgrades">
      {/* The settings group eyebrow names this section on screen. */}
      <h2 id="workspace-upgrades" className="sr-only">
        Upgrades
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Upgrades move your Workspace repository to the layout that this version
        of ctx| reads. Nothing changes until you merge the pull request.
      </p>
      <div className="mt-3 flex flex-col gap-3">
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
        ) : data ? (
          <>
            <p className="text-xs text-muted-foreground">
              {formatHealthLine(data.formatVersion, data.codeFormat)}
            </p>
            {pending.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No upgrades are pending.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {pending.map((item) => (
                  <UpgradeItemRow
                    key={item.key}
                    item={item}
                    orgSlug={orgSlug}
                    workspaceSlug={workspaceSlug}
                    isAdmin={isAdmin}
                    {...(props.onFixWithAgent
                      ? { onFixWithAgent: props.onFixWithAgent }
                      : {})}
                  />
                ))}
              </ul>
            )}
            {applied.length > 0 ? (
              <Disclosure className="-mx-2">
                <DisclosureHeader>
                  <span className="text-xs text-muted-foreground">History</span>
                </DisclosureHeader>
                <DisclosurePanel className="px-2">
                  <ul
                    className="flex flex-col gap-3 pt-1"
                    aria-label="Applied upgrades"
                  >
                    {applied.map((item) => (
                      <UpgradeItemRow
                        key={item.key}
                        item={item}
                        orgSlug={orgSlug}
                        workspaceSlug={workspaceSlug}
                        isAdmin={isAdmin}
                      />
                    ))}
                  </ul>
                </DisclosurePanel>
              </Disclosure>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  )
}
