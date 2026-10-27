import { IconAlertTriangle, IconCircleCheck } from "@tabler/icons-react"
import { useLocation } from "@tanstack/react-router"
import { Link } from "react-aria-components"

import { SkeletonText, useSkeletonHold } from "@/components/ui/Skeleton"
import { WORKSPACE_UPGRADES_HASH } from "@/features/workspace-upgrades/queries"
import {
  useUpgradesStatus,
  WorkspaceUpgrades,
} from "@/features/workspace-upgrades/WorkspaceUpgrades"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"

import { DangerCard } from "./settings/DangerCard"
import { GeneralCard } from "./settings/GeneralCard"
import { GraphCard, graphStatus } from "./settings/GraphCard"
import { RepositoryCard, useWriteAccess } from "./settings/RepositoryCard"
import { jumpToSettingsCard, type SettingsPart } from "./settings/SettingsCard"
import {
  SourcesCard,
  useSourcesNeedYou,
  useWorkspaceActivity,
} from "./settings/SourcesCard"
import type { WorkspaceDetail } from "./types"

const PART_TITLE: Partial<Record<SettingsPart, string>> = {
  upgrades: "Upgrades",
  sources: "Sources",
  graph: "Knowledge graph",
  repository: "Repository",
}

/**
 * Workspace settings: one card for each part of the Workspace. Each card
 * states its state one time, in its body, and holds its own settings and
 * actions. The line at the top names the parts that need the user and the
 * parts at work, with a link to each card.
 */
export function WorkspaceSettingsPane(props: {
  orgSlug: string
  workspace: WorkspaceDetail
  /** Opens a Workspace file in the Files pane. */
  onOpenFile: (path: string) => void
  /** Opens the Workspace chat with this prompt in the composer. */
  onFixWithAgent?: (prompt: string) => void
}) {
  const { orgSlug, workspace } = props
  const hash = useLocation({ select: (location) => location.hash })
  const upgrades = useUpgradesStatus(orgSlug, workspace.slug)
  const summaryLoading = useSkeletonHold(upgrades.loading)
  const activity = useWorkspaceActivity(orgSlug, workspace.slug)
  const sourcesNeedYou = useSourcesNeedYou(orgSlug, workspace)
  const graph = graphStatus(workspace, activity.hydrate)
  const access = useWriteAccess(workspace)

  const needs: SettingsPart[] = [
    ...(upgrades.needsYou ? (["upgrades"] as const) : []),
    ...(sourcesNeedYou ? (["sources"] as const) : []),
    ...(graph.needsYou ? (["graph"] as const) : []),
    ...(access.needsYou ? (["repository"] as const) : []),
  ]
  // A part that needs the user shows one time, in the first line.
  const running: SettingsPart[] = [
    ...(upgrades.working ? (["upgrades"] as const) : []),
    ...(activity.sources.length ? (["sources"] as const) : []),
    ...(graph.working ? (["graph"] as const) : []),
  ].filter((part) => !needs.includes(part))

  return (
    // The pane is a container: the cards take columns when it is wide.
    <div
      data-settings-scroll
      className="@container min-h-0 flex-1 overflow-auto"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6">
        <header className="flex flex-col gap-1.5">
          <h1 className="text-lg font-medium tracking-tight">
            Workspace settings
          </h1>
          {summaryLoading ? (
            <SkeletonText className="text-sm" boneClassName="w-72" />
          ) : (
            <SettingsSummary needs={needs} running={running} />
          )}
        </header>

        <WorkspaceUpgrades
          orgSlug={orgSlug}
          workspaceSlug={workspace.slug}
          landing={hash === WORKSPACE_UPGRADES_HASH}
          {...(props.onFixWithAgent
            ? { onFixWithAgent: props.onFixWithAgent }
            : {})}
        />
        <SourcesCard
          orgSlug={orgSlug}
          workspace={workspace}
          activity={activity}
          needsYou={sourcesNeedYou}
        />
        <GraphCard
          workspace={workspace}
          hydrate={activity.hydrate}
          onOpenFile={props.onOpenFile}
          onFixWithAgent={props.onFixWithAgent}
        />
        <RepositoryCard orgSlug={orgSlug} workspace={workspace} />
        <GeneralCard orgSlug={orgSlug} workspace={workspace} />
        <DangerCard orgSlug={orgSlug} workspace={workspace} />
      </div>
    </div>
  )
}

/** The top line: the parts that need the user, then the parts at work. */
function SettingsSummary(props: {
  needs: SettingsPart[]
  running: SettingsPart[]
}) {
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

function PartLinks(props: {
  parts: SettingsPart[]
  tone: "attention" | "muted"
}) {
  return props.parts.map((part, index) => (
    <span key={part}>
      {index > 0 ? (
        <span aria-hidden className="text-muted-foreground">
          {" · "}
        </span>
      ) : null}
      <Link
        onPress={() => jumpToSettingsCard(part)}
        className={cn(
          "cursor-pointer rounded-md underline underline-offset-2",
          props.tone === "attention"
            ? "text-amber-200 decoration-amber-200/40 hover:decoration-amber-200"
            : "text-muted-foreground decoration-muted-foreground/40 hover:text-foreground",
          focusVisibleClassName,
        )}
      >
        {PART_TITLE[part]}
      </Link>
    </span>
  ))
}
