/**
 * PROTOTYPE — throwaway. Do not import from production code.
 *
 * Question: how should the Workspace settings pane use its width, and should
 * the settings pane open narrower than Files and Graph?
 *
 * `Current` is the real `WorkspaceSurface`. The variants are static mocks in
 * the same AppShell with the same data. Each variant has a `paneWidth`
 * control (0 = the current 50/50 split).
 */
import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  IconAffiliate,
  IconArrowsDiagonal2,
  IconFileDiff,
  IconFolder,
  IconGitBranch,
  IconLayoutSidebarRightCollapse,
  IconPencil,
  IconPlus,
  IconSettings,
  IconTrash,
  IconUnlink,
} from "@tabler/icons-react"
import type { SourceProvider } from "backend/domain/workspace-sources/sources-file"
import type { CSSProperties, ReactNode } from "react"
import { Button } from "@/components/ui/Button"
import { TextField } from "@/components/ui/TextField"
import {
  SOURCE_PROVIDER_UI,
  sourceProviderLabel,
} from "@/features/workspace-sources/source-provider-ui"
import { cn } from "@/lib/utils"
import { workspaceShellHandlers } from "@/mocks/workspace-handlers"
import {
  orgConnectionsHandler,
  workspaceSourceFixture,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "@/mocks/workspace-sources-handlers"
import { orgPageDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import type { WorkspaceDetail } from "./types"
import { WorkspaceSurface } from "./WorkspaceSurface"
import { docsWorkspace } from "./workspace-fixtures"
import {
  workspaceChatColumnClassName,
  workspaceChromeCardClassName,
  workspaceChromeCardPaneClassName,
  workspaceChromeIconTabClassName,
  workspaceChromeOuterClassName,
  workspaceChromeTabClassName,
  workspaceChromeTabStripClassName,
} from "./workspaceChrome"

// ---------------------------------------------------------------------------
// Data: the same shape as the settings screenshot, with made-up names.

const workspace: WorkspaceDetail = {
  ...docsWorkspace,
  slug: "acme-context",
  displayName: "context",
  workspaceRepositoryUrl: "https://github.com/acme/context",
  activeProjectionUrl: "https://github.com/acme/context",
  linkedRepositories: ["acme/platform", "acme/demo-app", "acme/governance"].map(
    (name, index) => ({
      id: `wlr_${index}`,
      workspaceId: docsWorkspace.id,
      gitUrl: `https://github.com/${name}`,
      desiredRef: "main",
      desiredSha: null,
      indexedSha: null,
      createdAt: "2026-10-01T10:00:00.000Z",
    }),
  ),
}

const missingDetail = "The connection does not exist in this organization"

type MockSource = {
  key: string
  scope: string
  connection: string | null
  status: "ok" | "connection_missing"
}

const missing = (key: string, scope: string): MockSource => ({
  key,
  scope,
  connection: null,
  status: "connection_missing",
})
const ok = (key: string, scope: string, connection: string): MockSource => ({
  key,
  scope,
  connection,
  status: "ok",
})

const sourceGroups: { provider: SourceProvider; sources: MockSource[] }[] = [
  {
    provider: "linear",
    sources: [
      missing("linear", "1 Linear team"),
      missing("linear-2", "1 Linear team · 1 project"),
      missing("linear-3", "1 Linear team · 1 project"),
      missing("linear-4", "1 Linear team · 2 projects"),
      ok("linear-5", "1 Linear team · 1 project", "Acme"),
    ],
  },
  {
    provider: "notion",
    sources: [
      missing("notion", "3 Notion pages · 1 Notion database"),
      missing("notion-2", "3 Notion pages · 1 Notion database"),
      ok("notion-3", "3 Notion pages · 1 Notion database", "Acme wiki"),
    ],
  },
  {
    provider: "slack",
    sources: [
      missing("slack", "1 Slack channel"),
      ok("slack-2", "1 Slack channel", "Acme"),
    ],
  },
]

const repositories = workspace.linkedRepositories.map((repository) =>
  repository.gitUrl.replace("https://github.com/", ""),
)

const connectionIds: Record<string, string> = {
  linear: "con_li",
  notion: "con_no",
  slack: "con_sl",
}

/** The same sources for the real `Current` story, through MSW. */
const sourcesResponse = workspaceSourceList({
  items: sourceGroups.flatMap(({ provider, sources }) =>
    sources.map((source) =>
      workspaceSourceFixture({
        sourceKey: source.key,
        provider,
        connectionId: source.connection ? connectionIds[provider] : null,
        connectionName: source.connection,
        scopeSummary: source.scope,
        status: source.status,
        statusDetail: source.status === "ok" ? null : missingDetail,
      }),
    ),
  ),
})

// ---------------------------------------------------------------------------
// Small shared bits (status words, pills). Each variant owns its layout.

function StatusWord(props: { status: MockSource["status"] }) {
  const isOk = props.status === "ok"
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 font-mono text-xs",
        isOk ? "text-emerald-400" : "text-amber-400",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          isOk ? "bg-emerald-400" : "bg-amber-400",
        )}
        aria-hidden
      />
      {isOk ? "OK" : "Connection missing"}
    </span>
  )
}

function PendingPill() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-zinc-800 px-2 py-0.5 text-xs text-muted-foreground">
      <span className="size-1.5 rounded-full bg-zinc-500" aria-hidden />
      Pending
    </span>
  )
}

function HeaderTags() {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1.5 rounded-md border border-teal-400/30 bg-teal-400/10 px-2 py-0.5 text-xs text-teal-200">
        <span className="size-1.5 rounded-full bg-current" aria-hidden />
        Can save changes
      </span>
      <span className="inline-flex items-center gap-1.5 rounded-md border border-teal-400/30 bg-teal-400/10 px-2 py-0.5 text-xs text-teal-200">
        <span className="size-1.5 rounded-full bg-current" aria-hidden />
        Ready
      </span>
    </div>
  )
}

function ProviderTile(props: { provider: SourceProvider | "github" }) {
  const { Icon } = SOURCE_PROVIDER_UI[props.provider]
  return (
    <span
      className="ctx-node size-8 shrink-0 rounded-md text-foreground"
      aria-hidden
    >
      <Icon className="size-4" />
    </span>
  )
}

function IconAction(props: { label: string; children: ReactNode }) {
  return (
    <Button variant="quiet" size="icon-sm" aria-label={props.label}>
      {props.children}
    </Button>
  )
}

function attentionOf(sources: MockSource[]) {
  return sources.filter((source) => source.status !== "ok").length
}

function groupMeta(sources: MockSource[]) {
  const attention = attentionOf(sources)
  return [
    `${sources.length} sources`,
    attention > 0
      ? `${attention} ${attention === 1 ? "needs" : "need"} attention`
      : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

const totalSources = sourceGroups.reduce(
  (sum, group) => sum + group.sources.length,
  0,
)
const totalAttention = sourceGroups.reduce(
  (sum, group) => sum + attentionOf(group.sources),
  0,
)

// ---------------------------------------------------------------------------
// Variant A — label rail. Each group is a row: a rail with the eyebrow and a
// one-line hint, then the content. The hairline spans the full content width.
// Below a 48rem container it stacks, as the pane does today.

function RailGroup(props: {
  eyebrow: string
  hint: ReactNode
  children: ReactNode
}) {
  return (
    <section className="grid gap-x-10 gap-y-5 border-t border-white/[0.06] py-8 @3xl:grid-cols-[12rem_minmax(0,1fr)]">
      <div>
        <h2 className="ctx-label text-muted-foreground">{props.eyebrow}</h2>
        <p className="mt-2 text-xs text-muted-foreground">{props.hint}</p>
      </div>
      <div className="min-w-0">{props.children}</div>
    </section>
  )
}

function VariantA() {
  return (
    <div className="@container min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-4xl px-6 pb-10 pt-4">
        <div className="flex items-start justify-between gap-4 pb-6">
          <div className="flex flex-col gap-3">
            <h1 className="text-lg font-medium tracking-tight">
              Workspace settings
            </h1>
            <HeaderTags />
          </div>
          <Button variant="primary" isDisabled>
            Save
          </Button>
        </div>

        <RailGroup eyebrow="General" hint="How your team finds this Workspace.">
          <div className="flex max-w-md flex-col gap-6">
            <TextField
              label="Name"
              defaultValue={workspace.displayName}
              description="Shown in the sidebar and to your team."
            />
            <TextField
              label="URL name"
              defaultValue={workspace.slug}
              description="Used in this Workspace's web address. If you change it, old links stop working."
            />
          </div>
        </RailGroup>

        <RailGroup
          eyebrow="Repository"
          hint="The GitHub repository where this Workspace keeps its files."
        >
          <div className="flex max-w-xl items-center gap-3 rounded-md border border-border px-3 py-2">
            <span
              className="ctx-node size-8 shrink-0 rounded-md text-muted-foreground"
              aria-hidden
            >
              <IconGitBranch className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">acme/context</p>
              <p className="truncate text-xs text-muted-foreground">
                {workspace.workspaceRepositoryUrl}
              </p>
            </div>
            <IconAction label="Edit main repository">
              <IconPencil className="size-4 text-muted-foreground" />
            </IconAction>
          </div>
        </RailGroup>

        <RailGroup
          eyebrow="Sources"
          hint={
            <>
              {totalSources} sources from 3 connectors · {totalAttention} need
              attention. Saved in{" "}
              <code className="font-mono">.ctxpipe/sources.yaml</code>.
            </>
          }
        >
          <div className="flex flex-col divide-y divide-white/[0.06]">
            <div className="pb-3">
              <div className="flex items-center gap-3">
                <ProviderTile provider="github" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm text-foreground">GitHub</h3>
                  <p className="text-xs text-muted-foreground">
                    {repositories.length} repositories
                  </p>
                </div>
                <Button variant="quiet">
                  <IconPlus className="size-4" aria-hidden />
                  Add repositories
                </Button>
              </div>
              <ul className="mt-1 pl-11">
                {repositories.map((name) => (
                  <li key={name} className="flex items-center gap-3 py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        Linked by a repositories file
                      </p>
                    </div>
                    <PendingPill />
                    <IconAction label={`Unlink ${name}`}>
                      <IconUnlink className="size-4 text-muted-foreground" />
                    </IconAction>
                  </li>
                ))}
              </ul>
            </div>
            {sourceGroups.map(({ provider, sources }) => (
              <div key={provider} className="py-3">
                <div className="flex items-center gap-3">
                  <ProviderTile provider={provider} />
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm text-foreground">
                      {sourceProviderLabel(provider)}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {groupMeta(sources)}
                    </p>
                  </div>
                  <Button variant="quiet">
                    <IconPlus className="size-4" aria-hidden />
                    Add
                  </Button>
                </div>
                <ul className="mt-1 pl-11">
                  {sources.map((source) => (
                    <li
                      key={source.key}
                      className="flex items-start gap-3 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">
                          {source.scope}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {source.connection ?? "No connection"} ·{" "}
                          <code className="font-mono">{source.key}</code>
                        </p>
                        {source.status === "ok" ? null : (
                          <p className="text-xs text-amber-200/80">
                            {missingDetail}
                          </p>
                        )}
                      </div>
                      <div className="flex h-8 shrink-0 items-center gap-1">
                        <span className="mr-1">
                          <StatusWord status={source.status} />
                        </span>
                        <IconAction label={`Edit ${source.key}`}>
                          <IconPencil className="size-4 text-muted-foreground" />
                        </IconAction>
                        <IconAction label={`Remove ${source.key}`}>
                          <IconTrash className="size-4 text-muted-foreground" />
                        </IconAction>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm text-teal-400">Add another connection</p>
        </RailGroup>

        <RailGroup
          eyebrow="Danger zone"
          hint="Your GitHub repository and its files stay."
        >
          <h3 className="text-sm font-medium text-foreground">
            Delete this Workspace
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Deletes this Workspace and its conversations.
          </p>
          <Button variant="outline" className="mt-4">
            Delete Workspace
          </Button>
        </RailGroup>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Variant B — narrow pane. Settings opens at 36rem; the chat keeps the rest.
// One column fills the pane, so each hairline runs edge to edge. Source rows
// put the status on the meta line, and a reason that repeats shows once per
// provider.

function NarrowGroup(props: { eyebrow: string; children: ReactNode }) {
  return (
    <section className="border-t border-white/[0.06] px-5 py-6">
      <h2 className="ctx-label text-muted-foreground">{props.eyebrow}</h2>
      <div className="mt-5">{props.children}</div>
    </section>
  )
}

function NarrowProvider(props: {
  provider: SourceProvider | "github"
  meta: string
  action: string
  note?: string
  children: ReactNode
}) {
  return (
    <div className="py-3">
      <div className="flex items-center gap-3">
        <ProviderTile provider={props.provider} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm text-foreground">
            {sourceProviderLabel(props.provider)}
          </h3>
          <p className="text-xs text-muted-foreground">{props.meta}</p>
        </div>
        <Button variant="quiet">
          <IconPlus className="size-4" aria-hidden />
          {props.action}
        </Button>
      </div>
      {props.note ? (
        <p className="mt-2 rounded-md bg-amber-400/5 px-3 py-2 text-xs text-amber-200/80">
          {props.note}
        </p>
      ) : null}
      <ul className="mt-1">{props.children}</ul>
    </div>
  )
}

function VariantB() {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="flex items-center justify-between gap-4 px-5 pb-4 pt-4">
        <h1 className="text-lg font-medium tracking-tight">Settings</h1>
        <Button variant="primary" isDisabled>
          Save
        </Button>
      </div>
      <div className="px-5 pb-5">
        <HeaderTags />
      </div>

      <NarrowGroup eyebrow="General">
        <div className="flex flex-col gap-6">
          <TextField
            label="Name"
            defaultValue={workspace.displayName}
            description="Shown in the sidebar and to your team."
          />
          <TextField
            label="URL name"
            defaultValue={workspace.slug}
            description="Used in this Workspace's web address. If you change it, old links stop working."
          />
        </div>
      </NarrowGroup>

      <NarrowGroup eyebrow="Repository">
        <p className="text-xs text-muted-foreground">
          The GitHub repository where this Workspace keeps its files.
        </p>
        <div className="mt-3 flex items-center gap-3 rounded-md border border-border px-3 py-2">
          <span
            className="ctx-node size-8 shrink-0 rounded-md text-muted-foreground"
            aria-hidden
          >
            <IconGitBranch className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-foreground">acme/context</p>
            <p className="truncate text-xs text-muted-foreground">
              {workspace.workspaceRepositoryUrl}
            </p>
          </div>
          <IconAction label="Edit main repository">
            <IconPencil className="size-4 text-muted-foreground" />
          </IconAction>
        </div>
      </NarrowGroup>

      <NarrowGroup eyebrow="Sources">
        <p className="text-sm text-muted-foreground">
          {totalSources} sources · {totalAttention} need attention
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Saved in <code className="font-mono">.ctxpipe/sources.yaml</code>
        </p>
        <div className="mt-2 flex flex-col divide-y divide-white/[0.06]">
          <NarrowProvider
            provider="github"
            meta={`${repositories.length} repositories`}
            action="Add"
          >
            {repositories.map((name) => (
              <li
                key={name}
                className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-foreground/[0.04]"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">{name}</p>
                  <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    <span
                      className="size-1.5 rounded-full bg-zinc-500"
                      aria-hidden
                    />
                    Pending · Linked by a repositories file
                  </p>
                </div>
                <IconAction label={`Unlink ${name}`}>
                  <IconUnlink className="size-4 text-muted-foreground" />
                </IconAction>
              </li>
            ))}
          </NarrowProvider>
          {sourceGroups.map(({ provider, sources }) => {
            const attention = attentionOf(sources)
            return (
              <NarrowProvider
                key={provider}
                provider={provider}
                meta={groupMeta(sources)}
                action="Add"
                note={
                  attention > 1
                    ? `${attention} sources use a connection that does not exist in this organization.`
                    : undefined
                }
              >
                {sources.map((source) => (
                  <li
                    key={source.key}
                    className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-foreground/[0.04]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">
                        {source.scope}
                      </p>
                      <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <StatusWord status={source.status} />
                        <span className="truncate">
                          {source.connection ? `· ${source.connection} ` : null}
                          · <code className="font-mono">{source.key}</code>
                        </span>
                      </p>
                      {attention === 1 && source.status !== "ok" ? (
                        <p className="text-xs text-amber-200/80">
                          {missingDetail}
                        </p>
                      ) : null}
                    </div>
                    <IconAction label={`Edit ${source.key}`}>
                      <IconPencil className="size-4 text-muted-foreground" />
                    </IconAction>
                    <IconAction label={`Remove ${source.key}`}>
                      <IconTrash className="size-4 text-muted-foreground" />
                    </IconAction>
                  </li>
                ))}
              </NarrowProvider>
            )
          })}
        </div>
        <p className="mt-3 text-sm text-teal-400">Add another connection</p>
      </NarrowGroup>

      <NarrowGroup eyebrow="Danger zone">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-foreground">
              Delete this Workspace
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Deletes this Workspace and its conversations. Your GitHub
              repository and its files stay.
            </p>
          </div>
          <Button variant="outline" className="shrink-0">
            Delete
          </Button>
        </div>
      </NarrowGroup>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Variant C — wide table. General puts the two fields side by side. Sources is
// one table with Source / Connection / Key / Status columns and a provider
// header row per group. Below a 42rem container the columns fold into the
// row.

const tableColumns =
  "@2xl:grid @2xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.8fr)_9.5rem_4.5rem] @2xl:items-center @2xl:gap-4"

function WideGroup(props: {
  eyebrow: string
  title?: string
  hint?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="border-t border-white/[0.06] py-7">
      <p className="ctx-label text-muted-foreground">{props.eyebrow}</p>
      {props.title || props.action ? (
        <div className="mt-5 flex items-end justify-between gap-4">
          <div>
            {props.title ? (
              <h2 className="text-sm font-medium text-foreground">
                {props.title}
              </h2>
            ) : null}
            {props.hint ? (
              <p className="mt-1 text-xs text-muted-foreground">{props.hint}</p>
            ) : null}
          </div>
          {props.action}
        </div>
      ) : null}
      <div className="mt-5">{props.children}</div>
    </section>
  )
}

function VariantC() {
  return (
    <div className="@container min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-5xl px-6 pb-10 pt-4">
        <div className="flex items-center justify-between gap-4 pb-6">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-medium tracking-tight">
              Workspace settings
            </h1>
            <HeaderTags />
          </div>
          <Button variant="primary" isDisabled>
            Save
          </Button>
        </div>

        <WideGroup eyebrow="General">
          <div className="grid items-start gap-6 @2xl:grid-cols-2">
            <TextField
              label="Name"
              defaultValue={workspace.displayName}
              description="Shown in the sidebar and to your team."
            />
            <TextField
              label="URL name"
              defaultValue={workspace.slug}
              description="Used in this Workspace's web address. If you change it, old links stop working."
            />
          </div>
        </WideGroup>

        <WideGroup
          eyebrow="Repository"
          title="Main repository"
          hint="The GitHub repository where this Workspace keeps its files."
        >
          <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2 @2xl:max-w-[calc(50%-0.75rem)]">
            <span
              className="ctx-node size-8 shrink-0 rounded-md text-muted-foreground"
              aria-hidden
            >
              <IconGitBranch className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">acme/context</p>
              <p className="truncate text-xs text-muted-foreground">
                {workspace.workspaceRepositoryUrl}
              </p>
            </div>
            <IconAction label="Edit main repository">
              <IconPencil className="size-4 text-muted-foreground" />
            </IconAction>
          </div>
        </WideGroup>

        <WideGroup
          eyebrow="Sources"
          title={`${totalSources} sources from 3 connectors · ${totalAttention} need attention`}
          hint={
            <>
              Saved in <code className="font-mono">.ctxpipe/sources.yaml</code>
            </>
          }
          action={
            <p className="shrink-0 text-sm text-teal-400">
              Add another connection
            </p>
          }
        >
          <div className="overflow-hidden rounded-md border border-white/[0.06]">
            <div
              className={cn(
                "hidden border-b border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs text-muted-foreground",
                tableColumns,
              )}
            >
              <span>Source</span>
              <span>Connection</span>
              <span>Key</span>
              <span>Status</span>
              <span className="sr-only">Actions</span>
            </div>

            <div className="flex items-center gap-3 border-b border-white/[0.06] bg-white/[0.02] px-3 py-2">
              <ProviderTile provider="github" />
              <p className="min-w-0 flex-1 text-sm text-foreground">
                GitHub{" "}
                <span className="text-xs text-muted-foreground">
                  · {repositories.length} repositories
                </span>
              </p>
              <Button variant="quiet">
                <IconPlus className="size-4" aria-hidden />
                Add repositories
              </Button>
            </div>
            {repositories.map((name) => (
              <div
                key={name}
                className={cn(
                  "flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/[0.06] px-3 py-2 hover:bg-foreground/[0.03]",
                  tableColumns,
                )}
              >
                <p className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {name}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  Repositories file
                </p>
                <span className="hidden @2xl:block" />
                <span>
                  <PendingPill />
                </span>
                <div className="flex justify-end">
                  <IconAction label={`Unlink ${name}`}>
                    <IconUnlink className="size-4 text-muted-foreground" />
                  </IconAction>
                </div>
              </div>
            ))}

            {sourceGroups.map(({ provider, sources }) => {
              const attention = attentionOf(sources)
              return (
                <div key={provider}>
                  <div className="flex items-center gap-3 border-b border-white/[0.06] bg-white/[0.02] px-3 py-2">
                    <ProviderTile provider={provider} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-foreground">
                        {sourceProviderLabel(provider)}{" "}
                        <span className="text-xs text-muted-foreground">
                          · {groupMeta(sources)}
                        </span>
                      </p>
                      {attention > 0 ? (
                        <p className="text-xs text-amber-200/80">
                          {attention === 1
                            ? `1 source: ${missingDetail.toLowerCase()}.`
                            : `${attention} sources: ${missingDetail.toLowerCase()}.`}
                        </p>
                      ) : null}
                    </div>
                    <Button variant="quiet">
                      <IconPlus className="size-4" aria-hidden />
                      Add
                    </Button>
                  </div>
                  {sources.map((source) => (
                    <div
                      key={source.key}
                      className={cn(
                        "flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/[0.06] px-3 py-2 last:border-b-0 hover:bg-foreground/[0.03]",
                        tableColumns,
                      )}
                    >
                      <p className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {source.scope}
                      </p>
                      <p
                        className={cn(
                          "truncate text-xs",
                          source.connection
                            ? "text-muted-foreground"
                            : "text-muted-foreground/60",
                        )}
                      >
                        {source.connection ?? "None"}
                      </p>
                      <code className="truncate font-mono text-xs text-muted-foreground">
                        {source.key}
                      </code>
                      <StatusWord status={source.status} />
                      <div className="flex justify-end">
                        <IconAction label={`Edit ${source.key}`}>
                          <IconPencil className="size-4 text-muted-foreground" />
                        </IconAction>
                        <IconAction label={`Remove ${source.key}`}>
                          <IconTrash className="size-4 text-muted-foreground" />
                        </IconAction>
                      </div>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </WideGroup>

        <WideGroup eyebrow="Danger zone">
          <div className="flex items-center justify-between gap-6 rounded-md border border-white/[0.06] px-4 py-3">
            <div>
              <h2 className="text-sm font-medium text-foreground">
                Delete this Workspace
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Deletes this Workspace and its conversations. Your GitHub
                repository and its files stay.
              </p>
            </div>
            <Button variant="outline" className="shrink-0">
              Delete Workspace
            </Button>
          </div>
        </WideGroup>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Frame: a static chat column and the pane chrome, so each variant sits at a
// real width beside the conversation.

function PrototypeFrame(props: { paneWidth: number; children: ReactNode }) {
  const locked = props.paneWidth > 0
  return (
    <div className="flex h-svh min-h-0 min-w-0">
      <div
        className={workspaceChatColumnClassName({
          maximized: false,
          paneOpen: true,
        })}
      >
        <div
          className={cn(
            workspaceChromeOuterClassName,
            "flex-1 px-3 max-md:px-0",
          )}
        >
          <div className={workspaceChromeTabStripClassName}>
            <span className={cn(workspaceChromeTabClassName, "px-3")}>
              Summarize open billing issues
            </span>
          </div>
          <div className={cn(workspaceChromeCardClassName, "p-6")}>
            <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
              <p className="ml-auto max-w-md rounded-md bg-zinc-800 px-3 py-2 text-sm">
                Summarize the open Linear issues for the billing team.
              </p>
              <div className="flex flex-col gap-2 text-sm text-muted-foreground">
                <p>
                  The billing team has 14 open issues. Five are about invoice
                  rounding, and three block the tax export.
                </p>
                <p>
                  Linear sources 1 to 4 have no connection, so this answer uses
                  only the fifth source.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
      <aside
        className={cn(
          workspaceChromeOuterClassName,
          "relative flex h-full min-h-0 pl-0 pr-3",
          locked
            ? "w-[var(--workspace-pane-width)] shrink-0 max-lg:w-auto max-lg:min-w-0 max-lg:flex-1"
            : "min-w-0 flex-1",
        )}
        style={
          locked
            ? ({
                "--workspace-pane-width": `${props.paneWidth}px`,
              } as CSSProperties)
            : undefined
        }
      >
        <div className={workspaceChromeTabStripClassName}>
          <div className="flex min-w-0 flex-1 items-end gap-1">
            <span className={workspaceChromeIconTabClassName(false)}>
              <IconFolder className="size-4" stroke={1.6} aria-hidden />
            </span>
            <span className={workspaceChromeIconTabClassName(false)}>
              <IconFileDiff className="size-4" stroke={1.6} aria-hidden />
            </span>
            <span className={workspaceChromeIconTabClassName(false)}>
              <IconAffiliate className="size-4" stroke={1.6} aria-hidden />
            </span>
            <span className={workspaceChromeIconTabClassName(true)}>
              <IconSettings className="size-4" stroke={1.6} aria-hidden />
            </span>
          </div>
          <div className="flex shrink-0 items-end gap-1 pb-1.5 text-muted-foreground">
            <IconArrowsDiagonal2 className="size-4" stroke={1.6} aria-hidden />
            <IconLayoutSidebarRightCollapse
              className="size-4"
              stroke={1.6}
              aria-hidden
            />
          </div>
        </div>
        <div className={workspaceChromeCardPaneClassName}>{props.children}</div>
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------

const variants = {
  A: VariantA,
  B: VariantB,
  C: VariantC,
}

function SettingsLayoutPrototype(props: {
  variant: keyof typeof variants
  /** The pane width in px. 0 keeps the current 50/50 split. */
  paneWidth: number
}) {
  const Variant = variants[props.variant]
  return (
    <PrototypeFrame paneWidth={props.paneWidth}>
      <Variant />
    </PrototypeFrame>
  )
}

const meta = {
  title: "Prototypes/Workspace settings layout",
  component: SettingsLayoutPrototype,
  decorators: [...orgPageDecorators],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: workspace.slug,
      pane: "settings",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        sources: [
          workspaceSourcesHandler(sourcesResponse),
          orgConnectionsHandler([
            { id: "con_gh", type: "github" },
            { id: "con_li", type: "linear", displayName: "Acme" },
            { id: "con_no", type: "notion", displayName: "Acme wiki" },
            { id: "con_sl", type: "slack", displayName: "Acme" },
          ]),
        ],
        page: workspaceShellHandlers({
          workspaces: [workspace],
          detail: workspace,
        }),
      },
    },
  },
  argTypes: {
    variant: { control: "inline-radio", options: Object.keys(variants) },
    paneWidth: { control: { type: "range", min: 0, max: 1200, step: 20 } },
  },
} satisfies Meta<typeof SettingsLayoutPrototype>

export default meta

type Story = StoryObj<typeof meta>

/** The real settings pane today: a 32rem column in a 50/50 pane. */
export const Current: Story = {
  args: { variant: "A", paneWidth: 0 },
  argTypes: {
    variant: { table: { disable: true } },
    paneWidth: { table: { disable: true } },
  },
  render: () => (
    <WorkspaceSurface
      orgSlug="acme"
      workspaceSlug={workspace.slug}
      paneParam="settings"
    />
  ),
}

/**
 * A — label rail, 50/50 pane. Below a 48rem pane the rail stacks: one column
 * fills the pane, so the hairlines span it and Sources gets more room.
 * Fields stay 28rem wide.
 */
export const LabelRail: Story = {
  name: "A — Label rail",
  args: { variant: "A", paneWidth: 0 },
}

/**
 * A — label rail, 920px pane. From a 48rem pane, each group puts its eyebrow
 * and a hint in a left rail beside the content.
 */
export const LabelRailWide: Story = {
  name: "A — Label rail (wide pane)",
  args: { variant: "A", paneWidth: 920 },
}

/**
 * B — narrow pane. Settings opens at 36rem and the conversation keeps the
 * rest. One column fills the pane. Source rows put the status on the meta
 * line, and a repeated reason shows once per provider.
 */
export const NarrowPane: Story = {
  name: "B — Narrow pane",
  args: { variant: "B", paneWidth: 576 },
}

/**
 * C — wide table, 880px pane. The fields sit side by side and Sources is one
 * table with columns. The table needs this width: at a 50/50 split the
 * Source column truncates. Below 42rem the columns fold.
 */
export const WideTable: Story = {
  name: "C — Wide table",
  args: { variant: "C", paneWidth: 880 },
}
