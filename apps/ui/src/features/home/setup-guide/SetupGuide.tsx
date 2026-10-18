import {
  IconBrandGithub,
  IconChevronRight,
  IconCircleCheck,
  IconCompass,
  IconFolderCode,
  IconGitBranch,
  IconMessageQuestion,
  IconPlugConnected,
  IconTerminal2,
  IconUsersPlus,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, useState, useSyncExternalStore } from "react"
import {
  Button as RACButton,
  ProgressBar as RACProgressBar,
} from "react-aria-components"
import { useSelectNav } from "@/components/ShellLayoutContext"
import { Button } from "@/components/ui/Button"
import { Disclosure, DisclosurePanel } from "@/components/ui/Disclosure"
import { Link as TextLink } from "@/components/ui/Link"
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton"
import { CopyableBlock } from "@/features/connectors/components/github-setup/CopyableBlock"
import { useGithubConnectFlow } from "@/features/connectors/useGithubConnectFlow"
import { sectionHeadingClassName } from "@/features/home/WorkspaceActivity"
import { WorkspaceAddRepositoriesDialog } from "@/features/workspace-sources/GithubSourceRepositories"
import { AwaitingMergeLink } from "@/features/workspace-sources/WorkspaceSources"
import type { WorkspaceHydrateView } from "@/features/workspaces/projection"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import {
  editorSetupCommand,
  mcpServerUrl,
  recordMcpConfigCopied,
} from "./editor-setup"
import type { GuideRow, GuideRowId } from "./guide-state"
import type { SetupGuide } from "./useSetupGuide"

export const ASK_PROMPT = "What should a new engineer read first?"

const rowCopy: Record<
  GuideRowId,
  { icon: ReactNode; title: string; body: string }
> = {
  github: {
    icon: <IconBrandGithub stroke={1.5} aria-hidden />,
    title: "Connect GitHub",
    body: "ctx| reads your code and keeps one knowledge repository.",
  },
  workspace: {
    icon: <IconFolderCode stroke={1.5} aria-hidden />,
    title: "Create your first Workspace",
    body: "ctx| creates a knowledge repository on GitHub, or uses one you have.",
  },
  repositories: {
    icon: <IconGitBranch stroke={1.5} aria-hidden />,
    title: "Link code repositories",
    body: "Answers cite real code from these repositories.",
  },
  ask: {
    icon: <IconMessageQuestion stroke={1.5} aria-hidden />,
    title: "Ask your first question",
    body: `Try: ${ASK_PROMPT}`,
  },
  tool: {
    icon: <IconPlugConnected stroke={1.5} aria-hidden />,
    title: "Connect a tool",
    body: "Copy Linear, Slack or Notion into your Workspace.",
  },
  invite: {
    icon: <IconUsersPlus stroke={1.5} aria-hidden />,
    title: "Invite your team",
    body: "Teammates see the same Workspaces.",
  },
  explore: {
    icon: <IconCompass stroke={1.5} aria-hidden />,
    title: "Explore a Workspace",
    body: "Open Files and Graph to see what the Workspace knows.",
  },
}

type GuideAction = {
  label: string
  onPress?: () => void
  isPending?: boolean
}

type GuideActions = Partial<Record<GuideRowId, GuideAction>>

type ReadyGuide = Extract<SetupGuide, { status: "ready" }>

/**
 * The "Get started" checklist on Home (CTX-552). Each row reads real data;
 * no click marks a row done. `onAsk` fills and focuses the Home composer.
 * `onCreateWorkspace` opens Add Workspace on Home, so the guide shows the
 * build after the dialog closes. "Link repositories" opens Add repositories
 * on Home too, so the row shows "Awaiting merge" after the pull request.
 */
export function SetupGuideCard(props: {
  orgSlug: string
  guide: ReadyGuide
  onAsk?: () => void
  onCreateWorkspace: () => void
}) {
  const { orgSlug, guide, onAsk, onCreateWorkspace } = props
  const navigate = useNavigate()
  const selectNav = useSelectNav()
  // An empty org slug turns off the flow's queries for a member.
  const github = useGithubConnectFlow({
    orgSlug: guide.role === "admin" ? orgSlug : "",
  })
  const landing = guide.landing
  const [addRepositoriesOpen, setAddRepositoriesOpen] = useState(false)
  const openWorkspace = (pane: string | undefined) => {
    if (!landing) return
    selectNav({ orgSlug, primary: "workspace", workspaceSlug: landing.slug })
    void navigate({
      to: "/$orgSlug/ws/$workspaceSlug",
      params: { orgSlug, workspaceSlug: landing.slug },
      search: { pane },
    })
  }
  const actions: GuideActions = {
    github: {
      label: "Connect GitHub",
      isPending: github.isSyncing,
      onPress: () => github.start("connect"),
    },
    // Only an owner or admin can pick the repository of a Workspace.
    workspace:
      guide.role === "admin"
        ? { label: "Create Workspace", onPress: onCreateWorkspace }
        : { label: "Ask an admin to create a Workspace." },
    repositories: landing
      ? {
          label: "Link repositories",
          onPress: () => setAddRepositoriesOpen(true),
        }
      : undefined,
    ask: onAsk ? { label: "Ask", onPress: onAsk } : undefined,
    tool: {
      label: "Open Connectors",
      onPress: () => {
        selectNav({ orgSlug, primary: "connectors" })
        void navigate({
          to: "/$orgSlug/connectors",
          params: { orgSlug },
          search: {
            error: undefined,
            error_description: undefined,
            pendingAccountClaim: undefined,
            notionConnectionId: undefined,
          },
        })
      },
    },
    invite: {
      label: "Invite",
      onPress: () => {
        selectNav({ orgSlug, primary: "other" })
        void navigate({
          to: "/$orgSlug/organization/$organizationView",
          params: { orgSlug, organizationView: "members" },
        })
      },
    },
    explore: landing
      ? { label: "Open Workspace", onPress: () => openWorkspace(undefined) }
      : undefined,
  }
  return (
    <>
      <SetupGuidePanel
        guide={guide}
        actions={actions}
        onOpenBuild={() => openWorkspace(undefined)}
      />
      {guide.role === "admin" ? github.SelfHostedWizardModal : null}
      {landing ? (
        <WorkspaceAddRepositoriesDialog
          orgSlug={orgSlug}
          workspaceSlug={landing.slug}
          isOpen={addRepositoriesOpen}
          onOpenChange={setAddRepositoriesOpen}
        />
      ) : null}
    </>
  )
}

function ActionButton(props: {
  action: GuideAction | undefined
  variant: "primary" | "outline" | "quiet"
  className?: string
}) {
  const { action } = props
  if (!action) return null
  // An action with no press is a note, for example "Ask an admin".
  if (!action.onPress)
    return (
      <p className={cn("text-sm text-muted-foreground", props.className)}>
        {action.label}
      </p>
    )
  return (
    <Button
      variant={props.variant}
      className={props.className}
      isPending={action.isPending}
      onPress={action.onPress}
    >
      {action.label}
    </Button>
  )
}

function SetupProgress(props: { done: number; total: number }) {
  return (
    <RACProgressBar
      aria-label="Setup progress"
      value={props.done}
      maxValue={props.total}
      className="h-1 w-24 shrink overflow-hidden rounded-full bg-zinc-800 max-sm:w-12"
    >
      {({ percentage }) => (
        <div
          className="h-full rounded-full bg-teal-400"
          style={{ width: `${percentage ?? 0}%` }}
        />
      )}
    </RACProgressBar>
  )
}

/**
 * The build of the first Workspace, under its done row. The list data has
 * two stages: waiting for the first commit, then loading the files.
 */
function WorkspaceBuild(props: {
  build: WorkspaceHydrateView
  onOpenBuild: () => void
}) {
  if (props.build === "ready") return null
  if (props.build === "failed") {
    return (
      <div className="mt-1.5 flex items-center gap-3">
        <p className="ctx-indexing-failed">
          <span className="ctx-indexing-failed-dot" aria-hidden />
          Build failed
        </p>
        <Button
          variant="quiet"
          className="h-6 px-1 text-xs"
          onPress={props.onOpenBuild}
        >
          See the error
        </Button>
      </div>
    )
  }
  const reading = props.build === "waiting_for_tip"
  return (
    <div className="mt-1.5 space-y-1">
      <p className="ctx-indexing">
        <span className="ctx-indexing-dot" aria-hidden />
        Building
        <span className="text-muted-foreground">
          · step {reading ? 1 : 2} of 2
        </span>
      </p>
      <p className="text-xs text-muted-foreground">
        {reading
          ? "Reading the Workspace repository."
          : "Loading the files. You can ask questions while it builds."}
      </p>
    </div>
  )
}

function GuideRows(props: {
  rows: GuideRow[]
  actions: GuideActions
  onOpenBuild: () => void
  /** The first open row gets the one primary action. */
  primaryId?: GuideRowId
}) {
  return (
    <ul className="space-y-1">
      {props.rows.map((row) => {
        const copy = rowCopy[row.id]
        if (row.done) {
          return (
            <li key={row.id} className="flex items-start gap-3 px-2 py-2">
              <span className="ctx-node size-7 border-transparent text-teal-400/80 [&>svg]:size-4">
                <IconCircleCheck stroke={1.5} aria-hidden />
              </span>
              <div className="min-w-0 flex-1 pt-1">
                <p className="text-sm text-muted-foreground">{copy.title}</p>
                {row.build ? (
                  <WorkspaceBuild
                    build={row.build}
                    onOpenBuild={props.onOpenBuild}
                  />
                ) : null}
              </div>
              <span className="pt-1.5 text-xs text-muted-foreground">Done</span>
            </li>
          )
        }
        if (row.id === props.primaryId) {
          return (
            <li
              key={row.id}
              className="flex items-start gap-3 rounded-md bg-zinc-900 px-2 py-3"
            >
              <span className="ctx-node size-7 text-zinc-300 [&>svg]:size-4">
                {copy.icon}
              </span>
              <div className="min-w-0 flex-1">
                <p className="pt-1 text-sm font-medium text-foreground">
                  {copy.title}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {copy.body}
                </p>
                {row.pending ? (
                  <AwaitingMergeLink change={row.pending} />
                ) : null}
                <ActionButton
                  action={props.actions[row.id]}
                  variant="primary"
                  className="mt-3"
                />
              </div>
            </li>
          )
        }
        return (
          <li key={row.id} className="flex items-center gap-3 px-2 py-2">
            <span className="ctx-node size-7 text-muted-foreground [&>svg]:size-4">
              {copy.icon}
            </span>
            <p className="min-w-0 flex-1 truncate text-sm text-zinc-300">
              {copy.title}
            </p>
            {row.pending ? <AwaitingMergeLink change={row.pending} /> : null}
            <ActionButton
              action={props.actions[row.id]}
              variant="quiet"
              className="h-7 px-1 text-xs"
            />
          </li>
        )
      })}
    </ul>
  )
}

const noSubscribe = () => () => {}

/**
 * Connects the user's own agents to ctx| (CTX-871). It is not a counted
 * row: no signal tells that a client uses the MCP server. The command and
 * the URL name the origin of this app, so they also work on a self-hosted
 * deployment or a preview.
 */
function EditorSetupStep() {
  // The server holds no public origin (its config names the private backend
  // URL), so the server and hydration value is `null`. The fields stay empty
  // and Copy stays off until the browser origin replaces it.
  const origin = useSyncExternalStore(
    noSubscribe,
    () => window.location.origin,
    () => null,
  )
  return (
    <div className="mt-1 flex items-start gap-3 px-2 py-3">
      <span className="ctx-node size-7 text-zinc-300 [&>svg]:size-4">
        <IconTerminal2 stroke={1.5} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="pt-1 text-sm font-medium text-foreground">
          Use ctx| from your agents
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          It works with the agents you already use, in an IDE, a CLI or terminal
          UI, or a desktop app: Cursor, Claude Code, Codex, or any MCP client.
          Run this command. It signs you in, finds your agents, and adds the
          ctx| MCP server to them.
        </p>
        <div className="mt-3 space-y-2">
          <CopyableBlock
            value={origin ? editorSetupCommand(origin) : ""}
            copyAriaLabel="Copy setup command"
            copiedAriaLabel="Setup command copied"
            copyErrorMessage="Could not copy. Copy the command manually."
            onCopied={() => recordMcpConfigCopied("setup_command")}
          />
          <p className="pt-1 text-xs text-muted-foreground">
            To set up a client by hand, use this MCP server URL.{" "}
            <TextLink
              href="https://docs.ctxpipe.ai/docs/mcp/mcp-docs"
              target="_blank"
              rel="noopener noreferrer"
              variant="secondary"
            >
              Steps for each client
            </TextLink>
          </p>
          <CopyableBlock
            value={origin ? mcpServerUrl(origin) : ""}
            copyAriaLabel="Copy MCP server URL"
            copiedAriaLabel="MCP server URL copied"
            copyErrorMessage="Could not copy. Copy the URL manually."
            onCopied={() => recordMcpConfigCopied("server_url")}
          />
        </div>
      </div>
    </div>
  )
}

function SetupGuidePanel(props: {
  guide: ReadyGuide
  actions: GuideActions
  onOpenBuild: () => void
}) {
  const { guide, actions } = props
  const { view } = guide

  if (view.kind === "hidden") return null

  if (view.kind === "complete") {
    return (
      <section
        aria-label="Get started"
        className="flex items-center gap-3 rounded-md bg-zinc-900/60 px-4 py-3"
      >
        <IconCircleCheck
          className="size-4 shrink-0 text-teal-400"
          stroke={1.5}
          aria-hidden
        />
        <p className="flex-1 text-sm text-foreground">
          Setup complete.{" "}
          <span className="text-muted-foreground">
            This guide goes away on your next visit.
          </span>
        </p>
        <Button
          variant="quiet"
          className="h-7 px-1 text-xs"
          onPress={guide.dismiss}
        >
          Dismiss
        </Button>
      </section>
    )
  }

  const { collapsed } = view
  return (
    <section
      aria-label="Get started"
      className="rounded-md bg-zinc-900/60 p-2 ring-1 ring-zinc-800"
    >
      <Disclosure
        isExpanded={!collapsed}
        onExpandedChange={(expanded) => guide.setCollapsed(!expanded)}
      >
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-2 px-2 pt-1",
            collapsed ? "pb-1" : "pb-2",
          )}
        >
          <RACButton
            slot="trigger"
            className={cn(
              "-ml-1 inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1 hover:text-teal-300",
              sectionHeadingClassName,
              focusVisibleClassName,
            )}
          >
            <IconChevronRight
              className={cn(
                "size-3.5 transition-transform",
                !collapsed && "rotate-90",
              )}
              aria-hidden
            />
            Get started
          </RACButton>
          <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
            {view.done} of {view.total} done
          </span>
          <SetupProgress done={view.done} total={view.total} />
          <span className="flex-1" />
          {collapsed ? (
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              Next
              <ActionButton
                action={actions[view.next]}
                variant="outline"
                className="h-7 px-2 text-xs"
              />
            </span>
          ) : null}
          <Button
            variant="quiet"
            className="h-7 px-1 text-xs"
            onPress={guide.dismiss}
          >
            Dismiss
          </Button>
        </div>
        <DisclosurePanel>
          <GuideRows
            rows={guide.rows}
            actions={actions}
            primaryId={view.next}
            onOpenBuild={props.onOpenBuild}
          />
          <EditorSetupStep />
        </DisclosurePanel>
      </Disclosure>
    </section>
  )
}

/**
 * Holds the place of the guide while its signals load. It has the box of the
 * collapsed card, or of the expanded admin card with the first row open.
 */
export function SetupGuideSkeleton(props: { collapsed: boolean }) {
  return (
    <section className="rounded-md bg-zinc-900/60 p-2 ring-1 ring-zinc-800">
      {/* The editor step has live Copy buttons, so it stays outside the busy region. */}
      <div aria-busy>
        <span className="sr-only">Loading the setup guide</span>
        <div
          className={cn(
            "flex items-center gap-x-3 px-2 pt-1",
            props.collapsed ? "pb-1" : "pb-2",
          )}
        >
          <Skeleton className="h-7 w-48" />
        </div>
        {props.collapsed ? null : (
          // The disclosure panel of the card has `pt-0.5`.
          <div className="pt-0.5">
            <ul className="space-y-1">
              <li className="flex items-start gap-3 rounded-md px-2 py-3">
                <Skeleton className="size-7 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="pt-1">
                    <SkeletonText className="text-sm" boneClassName="w-40" />
                  </div>
                  <SkeletonText
                    className="mt-0.5 text-sm"
                    boneClassName="w-72"
                  />
                  <Skeleton className="mt-3 block h-9 w-32" />
                </div>
              </li>
              {[0, 1, 2, 3, 4].map((row) => (
                <li key={row} className="flex items-center gap-3 px-2 py-2">
                  <Skeleton className="size-7 shrink-0" />
                  <SkeletonText
                    className="flex-1 text-sm"
                    boneClassName="w-48"
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {props.collapsed ? null : <EditorSetupStep />}
    </section>
  )
}
