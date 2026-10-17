import { IconGitPullRequest } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Link as TextLink } from "@/components/ui/Link"
import {
  Skeleton,
  SkeletonText,
  useSkeletonHold,
} from "@/components/ui/Skeleton"
import { StatusTag } from "@/features/workspaces/StatusTag"
import {
  startWorkspaceUpgrade,
  useIsOrgAdmin,
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
  upgradeCanStart,
  upgradeStartedMessage,
} from "./upgrade-copy"

/**
 * One upgrade. `isAdmin` is `null` while the role loads: no action shows.
 * `estimate` is the slot for the cost estimate of a re-ingestion item
 * (CTX-746). The list fills it from `item.estimate` when the API gives one.
 */
export function UpgradeItemCard(props: {
  item: WorkspaceUpgradeItem
  isAdmin: boolean | null
  onStart: () => void
  isStarting?: boolean
  estimate?: ReactNode
}) {
  const { item, isAdmin, onStart, isStarting, estimate } = props
  const stepsWithNotes = item.steps.filter((step) => step.report.length > 0)
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

      {stepsWithNotes.length > 0 ? (
        <div className="mt-3 rounded-md bg-white/[0.03] px-3 py-2">
          <p className="text-xs font-medium text-foreground">Notes</p>
          <ul className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
            {stepsWithNotes.flatMap((step) =>
              step.report.map((line, index) => (
                <li key={`${step.format}-${index}`}>{line}</li>
              )),
            )}
          </ul>
        </div>
      ) : null}

      {estimate ? (
        <div className="mt-3 text-xs text-muted-foreground">{estimate}</div>
      ) : null}

      {item.status === "blocked" ? (
        <div className="mt-3">
          <InlineAlert variant="warning" title={upgradeBlockedCopy(item).title}>
            <p>{upgradeBlockedCopy(item).body}</p>
          </InlineAlert>
        </div>
      ) : item.note ? (
        <p className="mt-3 text-xs text-muted-foreground">{item.note}</p>
      ) : null}

      {item.status === "failed" ? (
        <div className="mt-3">
          <InlineAlert variant="error" title="The upgrade failed">
            <p>{item.failureReason ?? "ctx| gives no reason."}</p>
            <p className="mt-1">Fix the cause, then start it again.</p>
          </InlineAlert>
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
        {upgradeCanStart(item) && isAdmin === true ? (
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

function UpgradeItemRow(props: {
  item: WorkspaceUpgradeItem
  orgSlug: string
  workspaceSlug: string
  isAdmin: boolean | null
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
      queryClient.invalidateQueries({
        queryKey: workspaceUpgradeKeys.list(orgSlug, workspaceSlug),
      }),
  })
  return (
    <UpgradeItemCard
      item={item}
      isAdmin={isAdmin}
      isStarting={startMutation.isPending}
      onStart={() => startMutation.mutate()}
      estimate={item.estimate ? formatUpgradeEstimate(item.estimate) : null}
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
}) {
  const { orgSlug, workspaceSlug } = props
  const upgradesQuery = useQuery(
    workspaceUpgradesOptions(orgSlug, workspaceSlug),
  )
  const loading = useSkeletonHold(upgradesQuery.isPending)
  const isAdmin = useIsOrgAdmin(orgSlug)
  const data = upgradesQuery.data

  return (
    <section aria-labelledby="workspace-upgrades">
      {/* The settings group eyebrow names this section on screen. */}
      <h2 id="workspace-upgrades" className="sr-only">
        Upgrades
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        An upgrade changes the layout of the Workspace repository. An owner or
        admin starts each one. ctx| never changes your default branch.
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
            {data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No upgrades are pending.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {data.items.map((item) => (
                  <UpgradeItemRow
                    key={item.key}
                    item={item}
                    orgSlug={orgSlug}
                    workspaceSlug={workspaceSlug}
                    isAdmin={isAdmin}
                  />
                ))}
              </ul>
            )}
          </>
        ) : null}
      </div>
    </section>
  )
}
