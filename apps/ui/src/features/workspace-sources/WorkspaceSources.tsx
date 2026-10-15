import {
  IconAlertTriangle,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  SOURCE_PROVIDERS,
  SOURCE_SCOPES,
  type SourceProvider,
  type SourceStatus,
} from "backend/domain/workspace-sources/sources-file"
import { type ComponentType, type ReactNode, useMemo, useState } from "react"
import { Heading, Link } from "react-aria-components"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Link as TextLink } from "@/components/ui/Link"
import { Modal } from "@/components/ui/Modal"
import {
  Skeleton,
  SkeletonText,
  useSkeletonHold,
} from "@/components/ui/Skeleton"
import { orgConnectionsOptions } from "@/features/connectors/queries/org-connections"
import type { WorkspaceLinkedRepository } from "@/features/workspaces/types"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import {
  GithubSourceRepositories,
  repositoryNeedsAttention,
  repositoryRows,
} from "./GithubSourceRepositories"
import {
  deleteWorkspaceSource,
  type PendingSourceChange,
  type SourceDelivery,
  sourceChangeMessage,
  type WorkspaceSource,
  workspaceSourceKeys,
  workspaceSourcesOptions,
} from "./queries"
import {
  SourceEditorDialog,
  type SourceEditorTarget,
} from "./SourceEditorDialog"
import {
  SOURCE_PROVIDER_UI,
  sourceAnchorId,
  sourceProviderLabel,
} from "./source-provider-ui"

// The same dot + word shape as `ConnectorHealthIndicator` on the Connectors page.
const statusBase = "inline-flex shrink-0 items-center gap-1.5 font-mono text-xs"

const STATUS_TAG: Record<
  SourceStatus,
  { label: string; className: string; dotClassName: string }
> = {
  ok: {
    label: "OK",
    className: `${statusBase} text-emerald-400`,
    dotClassName: "size-1.5 rounded-full bg-emerald-400",
  },
  invalid: {
    label: "Not valid",
    className: `${statusBase} text-red-400`,
    dotClassName: "size-1.5 rounded-full bg-red-400",
  },
  connection_missing: {
    label: "Connection missing",
    className: `${statusBase} text-amber-400`,
    dotClassName: "size-1.5 rounded-full bg-amber-400",
  },
  out_of_access: {
    label: "Out of access",
    className: `${statusBase} text-amber-400`,
    dotClassName: "size-1.5 rounded-full bg-amber-400",
  },
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/**
 * The summary line under the heading, for example
 * "3 sources from 2 connectors · 1 needs attention".
 */
function connectorsSummary(
  items: WorkspaceSource[],
  pendingChanges: PendingSourceChange[],
  linkedRepositoryCount: number,
) {
  const connectors = new Set(
    items.flatMap((item) =>
      item.connectionId && item.connectionName ? [item.connectionId] : [],
    ),
  ).size
  const attention = items.filter((item) => item.status !== "ok").length
  return [
    items.length > 0
      ? `${plural(items.length, "source")} from ${plural(connectors, "connector")}`
      : linkedRepositoryCount > 0
        ? `${linkedRepositoryCount} linked ${linkedRepositoryCount === 1 ? "repository" : "repositories"}`
        : "No sources yet",
    attention > 0
      ? `${attention} ${attention === 1 ? "needs" : "need"} attention`
      : null,
    pendingChanges.length > 0
      ? `${plural(pendingChanges.length, "change")} awaiting merge`
      : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

function AwaitingMergeLink(props: { change: PendingSourceChange }) {
  const { change } = props
  return (
    <TextLink
      href={change.pullRequestUrl}
      target="_blank"
      rel="noreferrer"
      variant="secondary"
      className="mt-0.5 inline-block text-xs"
    >
      {change.action === "remove" ? "Removal awaiting merge" : "Awaiting merge"}
    </TextLink>
  )
}

function SourceRow(props: {
  source: WorkspaceSource
  pending: PendingSourceChange | undefined
  onEdit: (() => void) | null
  onRemove: (() => void) | null
}) {
  const { source, pending, onEdit, onRemove } = props
  const tag = STATUS_TAG[source.status]
  return (
    <li className="flex items-start gap-2 py-1">
      <div className="min-w-0 flex-1 py-0.5">
        <p className="truncate text-sm text-foreground">
          {source.scopeSummary}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {source.connectionName ?? "No connection"} ·{" "}
          <code className="font-mono">{source.sourceKey}</code>
        </p>
        {source.statusDetail ? (
          <p
            className={cn(
              "mt-0.5 text-xs",
              source.status === "ok"
                ? "text-muted-foreground"
                : "text-amber-200/80",
            )}
          >
            {source.statusDetail}
          </p>
        ) : null}
        {pending ? <AwaitingMergeLink change={pending} /> : null}
      </div>
      <div className="flex h-8 shrink-0 items-center gap-1">
        <span className={cn(tag.className, "mr-1")}>
          <span className={tag.dotClassName} aria-hidden />
          {tag.label}
        </span>
        {onEdit ? (
          <Button
            variant="quiet"
            size="icon-sm"
            aria-label={`Edit ${source.sourceKey}`}
            onPress={onEdit}
          >
            <IconPencil className="size-4 text-muted-foreground" aria-hidden />
          </Button>
        ) : null}
        {onRemove ? (
          <Button
            variant="quiet"
            size="icon-sm"
            aria-label={`Remove ${source.sourceKey}`}
            onPress={onRemove}
          >
            <IconTrash className="size-4 text-muted-foreground" aria-hidden />
          </Button>
        ) : null}
      </div>
    </li>
  )
}

function PendingAddRow(props: { change: PendingSourceChange }) {
  return (
    <li className="flex items-start gap-2 py-1">
      <div className="min-w-0 flex-1 py-0.5">
        <p className="truncate text-sm text-foreground">New source</p>
        <p className="truncate text-xs text-muted-foreground">
          <code className="font-mono">{props.change.sourceKey}</code>
        </p>
        <AwaitingMergeLink change={props.change} />
      </div>
    </li>
  )
}

/**
 * The GitHub section lists repositories, not source entries. These notes
 * keep what a source row shows otherwise: a pending pull request and a
 * status that is not ok.
 */
function GithubSourceNotes(props: {
  sources: WorkspaceSource[]
  pendingAdds: PendingSourceChange[]
  pendingOf: (sourceKey: string) => PendingSourceChange | undefined
}) {
  const { sources, pendingAdds, pendingOf } = props
  const notes = sources.filter(
    (source) =>
      pendingOf(source.sourceKey) ||
      (source.status !== "ok" && source.statusDetail),
  )
  if (notes.length === 0 && pendingAdds.length === 0) return null
  return (
    <ul className="mt-1 flex flex-col gap-1">
      {notes.map((source) => {
        const pending = pendingOf(source.sourceKey)
        return (
          <li key={source.sourceKey} className="py-1">
            <p className="truncate text-xs text-muted-foreground">
              {source.connectionName ?? "No connection"} ·{" "}
              <code className="font-mono">{source.sourceKey}</code>
            </p>
            {source.status !== "ok" && source.statusDetail ? (
              <p className="mt-0.5 text-xs text-amber-200/80">
                {source.statusDetail}
              </p>
            ) : null}
            {pending ? <AwaitingMergeLink change={pending} /> : null}
          </li>
        )
      })}
      {pendingAdds.map((change) => (
        <PendingAddRow key={change.sourceKey} change={change} />
      ))}
    </ul>
  )
}

/**
 * One provider group: an icon tile, a name with a muted meta line, an
 * optional action, and the rows under the name.
 */
function ConnectorGroup(props: {
  id?: string
  Icon: ComponentType<{ className?: string }>
  title: string
  meta: string
  action?: ReactNode
  children?: ReactNode
}) {
  const { id, Icon, title, meta, action, children } = props
  return (
    <div
      id={id}
      ref={id ? scrollIntoViewWhenHashMatches : undefined}
      className="scroll-mt-4 py-3"
    >
      <div className="flex items-center gap-3">
        <span
          className="ctx-node size-8 shrink-0 rounded-md text-foreground"
          aria-hidden
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm text-foreground">{title}</h3>
          <p className="truncate text-xs text-muted-foreground">{meta}</p>
        </div>
        {action}
      </div>
      {children ? <div className="mt-1 pl-11">{children}</div> : null}
    </div>
  )
}

/** Scroll to the provider section that the URL hash names. */
function scrollIntoViewWhenHashMatches(element: HTMLElement | null) {
  if (element && window.location.hash === `#${element.id}`)
    element.scrollIntoView({ block: "start" })
}

function SourcesSkeleton() {
  return (
    <div className="mt-3 flex flex-col divide-y divide-white/[0.06]" aria-busy>
      <span className="sr-only">Loading sources</span>
      {[0, 1].map((group) => (
        <div key={group} className="py-3">
          <div className="flex items-center gap-3">
            <Skeleton className="size-8 shrink-0 rounded-md" />
            <div className="min-w-0 flex-1">
              <SkeletonText className="text-sm" boneClassName="h-3.5 w-24" />
              <SkeletonText className="text-xs" boneClassName="w-16" />
            </div>
          </div>
          <div className="mt-1 pl-11">
            <div className="flex items-start gap-2 py-1">
              <div className="min-w-0 flex-1 py-0.5">
                <SkeletonText className="text-sm" boneClassName="h-3.5 w-40" />
                <SkeletonText className="text-xs" boneClassName="w-28" />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * The "Sources" section of the Workspace settings pane: the entries of
 * `.ctxpipe/sources.yaml`, grouped by provider. Each provider group has the
 * anchor `source-<provider>`.
 */
export function WorkspaceSources(props: {
  orgSlug: string
  workspaceSlug: string
  /** The repositories linked to the Workspace, for the GitHub section. */
  linkedRepositories?: WorkspaceLinkedRepository[]
  workspaceRepositoryUrl?: string | null
}) {
  const {
    orgSlug,
    workspaceSlug,
    linkedRepositories,
    workspaceRepositoryUrl = null,
  } = props
  const queryClient = useQueryClient()
  const sourcesQuery = useQuery(workspaceSourcesOptions(orgSlug, workspaceSlug))
  const loading = useSkeletonHold(sourcesQuery.isPending)
  const connectionsQuery = useQuery(orgConnectionsOptions(orgSlug))
  const [editor, setEditor] = useState<SourceEditorTarget | null>(null)
  const [removing, setRemoving] = useState<WorkspaceSource | null>(null)
  const [githubAddOpen, setGithubAddOpen] = useState(false)

  const removeMutation = useMutation({
    mutationFn: (input: { sourceKey: string; delivery: SourceDelivery }) =>
      deleteWorkspaceSource(
        orgSlug,
        workspaceSlug,
        input.sourceKey,
        input.delivery,
      ),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceSourceKeys.list(orgSlug, workspaceSlug),
      })
      toast.success(sourceChangeMessage(result))
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const connectionsOf = (provider: SourceProvider) =>
    (connectionsQuery.data ?? [])
      .filter(
        (connection) =>
          connection.type === SOURCE_SCOPES[provider].connectionType,
      )
      .map(({ id, displayName }) => ({ id, displayName }))

  const data = sourcesQuery.data
  const canEdit = data?.canEdit ?? false
  const directCommitAllowed = data?.directCommitAllowed ?? false
  const items = data?.items ?? []
  const githubRepositories = useMemo(
    () =>
      repositoryRows(
        linkedRepositories ?? [],
        (data?.items ?? []).filter((item) => item.provider === "github"),
      ),
    [linkedRepositories, data?.items],
  )
  const pendingChanges = data?.pendingChanges ?? []
  const pendingOf = (sourceKey: string) =>
    pendingChanges.find((change) => change.sourceKey === sourceKey)
  const unknownProvider = items.filter((item) => item.provider == null)
  const groups = SOURCE_PROVIDERS.filter(
    (provider) =>
      items.some((item) => item.provider === provider) ||
      pendingChanges.some((change) => change.provider === provider) ||
      connectionsOf(provider).length > 0 ||
      (provider === "github" && (linkedRepositories?.length ?? 0) > 0),
  )
  const isEmpty =
    groups.length === 0 && unknownProvider.length === 0 && !data?.fileError

  return (
    <section className="max-w-lg" aria-labelledby="workspace-sources">
      {/* The settings group eyebrow names this section on screen. */}
      <h2 id="workspace-sources" className="sr-only">
        Sources
      </h2>
      {loading ? (
        <SkeletonText className="text-sm" boneClassName="h-3.5 w-48" />
      ) : data && !isEmpty ? (
        <p className="text-sm text-muted-foreground">
          {connectorsSummary(
            items,
            pendingChanges,
            linkedRepositories?.length ?? 0,
          )}
        </p>
      ) : null}
      {data && isEmpty ? null : (
        <p className="mt-0.5 text-xs text-muted-foreground">
          Saved in{" "}
          <code className="font-mono">
            {data?.path ?? ".ctxpipe/sources.yaml"}
          </code>
        </p>
      )}

      {loading ? (
        <SourcesSkeleton />
      ) : sourcesQuery.isError ? (
        <div className="mt-4">
          <InlineAlert
            variant="error"
            actions={
              <Button
                variant="secondary"
                onPress={() => sourcesQuery.refetch()}
              >
                Retry
              </Button>
            }
          >
            Could not load the sources of this Workspace.
          </InlineAlert>
        </div>
      ) : isEmpty ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            No sources yet. Connect a tool under Connectors, then add it to this
            Workspace.
          </p>
          <div>
            <Link
              href={`/${orgSlug}/connectors`}
              className={cn(
                "inline-flex h-9 items-center rounded-md bg-primary px-3.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90",
                focusVisibleClassName,
              )}
            >
              Add connection
            </Link>
          </div>
        </div>
      ) : (
        <>
          {data?.fileError ? (
            <div className="mt-4">
              <InlineAlert
                variant="error"
                title="The sources file is not valid"
              >
                {data.fileError}
              </InlineAlert>
            </div>
          ) : null}
          <div className="mt-3 flex flex-col divide-y divide-white/[0.06]">
            {unknownProvider.length > 0 ? (
              <ConnectorGroup
                Icon={IconAlertTriangle}
                title="Entries not valid"
                meta={
                  unknownProvider.length === 1
                    ? "1 entry"
                    : `${unknownProvider.length} entries`
                }
              >
                <ul className="flex flex-col">
                  {unknownProvider.map((source) => (
                    <SourceRow
                      key={source.sourceKey}
                      source={source}
                      pending={pendingOf(source.sourceKey)}
                      onEdit={null}
                      onRemove={canEdit ? () => setRemoving(source) : null}
                    />
                  ))}
                </ul>
              </ConnectorGroup>
            ) : null}
            {groups.map((provider) => {
              const { Icon } = SOURCE_PROVIDER_UI[provider]
              const label = sourceProviderLabel(provider)
              const sources = items.filter((item) => item.provider === provider)
              const pendingAdds = pendingChanges.filter(
                (change) =>
                  change.provider === provider &&
                  change.action === "add" &&
                  !sources.some((item) => item.sourceKey === change.sourceKey),
              )
              // The GitHub group counts repositories, not source entries.
              const repositories =
                provider === "github" ? githubRepositories : null
              const attention = repositories
                ? repositories.filter(repositoryNeedsAttention).length
                : sources.filter((item) => item.status !== "ok").length
              const connected = connectionsOf(provider).length > 0
              const meta =
                [
                  repositories
                    ? repositories.length > 0
                      ? `${repositories.length} ${repositories.length === 1 ? "repository" : "repositories"}`
                      : null
                    : sources.length > 0
                      ? plural(sources.length, "source")
                      : null,
                  attention > 0
                    ? `${attention} ${attention === 1 ? "needs" : "need"} attention`
                    : null,
                  pendingAdds.length > 0
                    ? `${pendingAdds.length} awaiting merge`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || `No ${label} sources yet`
              return (
                <ConnectorGroup
                  key={provider}
                  id={sourceAnchorId(provider)}
                  Icon={Icon}
                  title={label}
                  meta={meta}
                  action={
                    provider === "github" && connected && canEdit ? (
                      <Button
                        variant="quiet"
                        onPress={() => setGithubAddOpen(true)}
                      >
                        <IconPlus className="size-4" aria-hidden />
                        Add repositories
                      </Button>
                    ) : provider !== "github" && connected && canEdit ? (
                      <Button
                        variant="quiet"
                        aria-label={`Add ${label} source`}
                        onPress={() => setEditor({ kind: "add", provider })}
                      >
                        <IconPlus className="size-4" aria-hidden />
                        Add
                      </Button>
                    ) : null
                  }
                >
                  {provider === "github" ? (
                    <>
                      <GithubSourceRepositories
                        orgSlug={orgSlug}
                        workspaceSlug={workspaceSlug}
                        workspaceRepositoryUrl={workspaceRepositoryUrl}
                        rows={githubRepositories}
                        sources={sources}
                        connections={connectionsOf(provider)}
                        canEdit={canEdit}
                        directCommitAllowed={directCommitAllowed}
                        addOpen={githubAddOpen}
                        onAddOpenChange={setGithubAddOpen}
                      />
                      <GithubSourceNotes
                        sources={sources}
                        pendingAdds={pendingAdds}
                        pendingOf={pendingOf}
                      />
                    </>
                  ) : sources.length === 0 &&
                    pendingAdds.length === 0 ? null : (
                    <ul className="flex flex-col">
                      {sources.map((source) => (
                        <SourceRow
                          key={source.sourceKey}
                          source={source}
                          pending={pendingOf(source.sourceKey)}
                          onEdit={
                            canEdit
                              ? () =>
                                  setEditor({ kind: "edit", provider, source })
                              : null
                          }
                          onRemove={canEdit ? () => setRemoving(source) : null}
                        />
                      ))}
                      {pendingAdds.map((change) => (
                        <PendingAddRow key={change.sourceKey} change={change} />
                      ))}
                    </ul>
                  )}
                </ConnectorGroup>
              )
            })}
          </div>
          <Link
            href={`/${orgSlug}/connectors`}
            className={cn(
              "mt-3 inline-block rounded-md text-sm text-teal-400 underline-offset-4 transition-colors hover:text-teal-300 hover:underline",
              focusVisibleClassName,
            )}
          >
            Add another connection
          </Link>
        </>
      )}

      {editor ? (
        <SourceEditorDialog
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          connections={connectionsOf(editor.provider)}
          directCommitAllowed={directCommitAllowed}
          target={editor}
          onClose={() => setEditor(null)}
        />
      ) : null}
      <Modal
        isOpen={removing != null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
        isDismissable
      >
        <Dialog role="alertdialog">
          {({ close }) => (
            <>
              <Heading
                slot="title"
                className="my-0 text-lg font-medium leading-6 text-foreground"
              >
                Remove {removing?.sourceKey ?? "source"}?
              </Heading>
              <p className="mt-3 text-sm text-muted-foreground">
                The change removes the source from the sources file. After it
                lands, the sync deletes its files. Git history keeps them.
              </p>
              <div className="mt-6 flex justify-end gap-2">
                <Button variant="quiet" onPress={close}>
                  Cancel
                </Button>
                {directCommitAllowed ? (
                  <Button
                    variant="secondary"
                    onPress={() => {
                      if (removing)
                        removeMutation.mutate({
                          sourceKey: removing.sourceKey,
                          delivery: "commit",
                        })
                      close()
                    }}
                  >
                    Commit directly
                  </Button>
                ) : null}
                <Button
                  variant="destructive"
                  autoFocus
                  onPress={() => {
                    if (removing)
                      removeMutation.mutate({
                        sourceKey: removing.sourceKey,
                        delivery: "pull_request",
                      })
                    close()
                  }}
                >
                  Open a pull request
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </section>
  )
}
