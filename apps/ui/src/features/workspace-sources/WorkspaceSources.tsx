import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  SOURCE_PROVIDERS,
  SOURCE_SCOPES,
  type SourceProvider,
  type SourceStatus,
} from "backend/domain/workspace-sources/sources-file"
import { useState } from "react"
import { Heading, Link } from "react-aria-components"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Link as TextLink } from "@/components/ui/Link"
import { Modal } from "@/components/ui/Modal"
import { Skeleton, SkeletonLine } from "@/components/ui/Skeleton"
import { orgConnectionsOptions } from "@/features/connectors/queries/org-connections"
import type { WorkspaceLinkedRepository } from "@/features/workspaces/types"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import { GithubSourceRepositories } from "./GithubSourceRepositories"
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

const pillBase =
  "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs"

const STATUS_TAG: Record<
  SourceStatus,
  { label: string; className: string; dotClassName: string }
> = {
  ok: {
    label: "OK",
    className: `${pillBase} border-teal-400/30 bg-teal-400/10 text-teal-200`,
    dotClassName: "size-1.5 rounded-full bg-teal-300",
  },
  invalid: {
    label: "Not valid",
    className: `${pillBase} border-red-400/30 bg-red-400/10 text-red-200`,
    dotClassName: "size-1.5 rounded-full bg-red-300",
  },
  connection_missing: {
    label: "Connection missing",
    className: `${pillBase} border-amber-400/30 bg-amber-400/10 text-amber-200`,
    dotClassName: "size-1.5 rounded-full bg-amber-300",
  },
  out_of_access: {
    label: "Out of access",
    className: `${pillBase} border-amber-400/30 bg-amber-400/10 text-amber-200`,
    dotClassName: "size-1.5 rounded-full bg-amber-300",
  },
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
    <li className="flex items-start gap-3 rounded-md px-2 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">
          {source.scopeSummary}
        </p>
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
      </div>
      <span className={tag.className}>
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
    </li>
  )
}

function PendingAddRow(props: { change: PendingSourceChange }) {
  return (
    <li className="flex items-start gap-3 rounded-md px-2 py-2">
      <div className="min-w-0 flex-1">
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
          <li key={source.sourceKey} className="px-2 py-1">
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

/** Scroll to the provider section that the URL hash names. */
function scrollIntoViewWhenHashMatches(element: HTMLElement | null) {
  if (element && window.location.hash === `#${element.id}`)
    element.scrollIntoView({ block: "start" })
}

function SourcesSkeleton() {
  return (
    <div className="mt-4 flex flex-col gap-6" aria-busy>
      <span className="sr-only">Loading sources</span>
      {[0, 1].map((group) => (
        <div key={group}>
          <div className="flex h-8 items-center gap-2">
            <Skeleton className="size-5 shrink-0" />
            <SkeletonLine className="h-3.5 w-24" />
          </div>
          <div className="mt-2 flex flex-col gap-2 px-2 py-2">
            <SkeletonLine className="h-3.5 w-48" />
            <SkeletonLine className="h-3 w-32" />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * The "Sources" section of the Workspace settings pane: the entries of
 * `.ctxpipe/sources.yaml`, grouped by provider. Each provider section has the
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
    linkedRepositories = [],
    workspaceRepositoryUrl = null,
  } = props
  const queryClient = useQueryClient()
  const sourcesQuery = useQuery(workspaceSourcesOptions(orgSlug, workspaceSlug))
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
  const pendingChanges = data?.pendingChanges ?? []
  const pendingOf = (sourceKey: string) =>
    pendingChanges.find((change) => change.sourceKey === sourceKey)
  const unknownProvider = items.filter((item) => item.provider == null)
  const groups = SOURCE_PROVIDERS.filter(
    (provider) =>
      items.some((item) => item.provider === provider) ||
      pendingChanges.some((change) => change.provider === provider) ||
      connectionsOf(provider).length > 0 ||
      (provider === "github" && linkedRepositories.length > 0),
  )
  const isEmpty =
    groups.length === 0 && unknownProvider.length === 0 && !data?.fileError

  return (
    <section className="mt-10 max-w-lg" aria-labelledby="workspace-sources">
      <h2
        id="workspace-sources"
        className="text-sm font-medium text-foreground"
      >
        Sources
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        What this Workspace syncs. The list comes from{" "}
        <code className="font-mono text-xs">
          {data?.path ?? ".ctxpipe/sources.yaml"}
        </code>
        .
      </p>

      {sourcesQuery.isPending ? (
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
        <div className="mt-4 flex max-w-md flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            No sources yet. Connect a tool, then add it to this Workspace.
          </p>
          <div>
            <Link
              href={`/${orgSlug}/connectors`}
              className={cn(
                "inline-flex h-9 items-center rounded-md bg-primary px-3.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90",
                focusVisibleClassName,
              )}
            >
              Connect a source
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
          {unknownProvider.length > 0 ? (
            <div className="mt-6">
              <h3 className="text-sm text-foreground">Entries not valid</h3>
              <ul className="mt-2 flex flex-col gap-1">
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
            </div>
          ) : null}
          {groups.map((provider) => {
            const { Icon, ScopeEditor } = SOURCE_PROVIDER_UI[provider]
            const label = sourceProviderLabel(provider)
            const sources = items.filter((item) => item.provider === provider)
            const pendingAdds = pendingChanges.filter(
              (change) =>
                change.provider === provider &&
                change.action === "add" &&
                !sources.some((item) => item.sourceKey === change.sourceKey),
            )
            const connected = connectionsOf(provider).length > 0
            return (
              <div
                key={provider}
                id={sourceAnchorId(provider)}
                ref={scrollIntoViewWhenHashMatches}
                className="mt-6 scroll-mt-4"
              >
                <div className="flex h-8 items-center gap-2">
                  <Icon className="size-5 shrink-0 text-foreground" />
                  <h3 className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {label}
                  </h3>
                  {provider === "github" && connected && canEdit ? (
                    <Button
                      variant="quiet"
                      onPress={() => setGithubAddOpen(true)}
                    >
                      <IconPlus className="size-4" aria-hidden />
                      Add repositories
                    </Button>
                  ) : provider !== "github" &&
                    connected &&
                    canEdit &&
                    ScopeEditor ? (
                    <Button
                      variant="quiet"
                      aria-label={`Add ${label} source`}
                      onPress={() => setEditor({ kind: "add", provider })}
                    >
                      <IconPlus className="size-4" aria-hidden />
                      Add source
                    </Button>
                  ) : null}
                </div>
                {provider === "github" ? (
                  <>
                    <GithubSourceRepositories
                      orgSlug={orgSlug}
                      workspaceSlug={workspaceSlug}
                      workspaceRepositoryUrl={workspaceRepositoryUrl}
                      linkedRepositories={linkedRepositories}
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
                ) : sources.length === 0 && pendingAdds.length === 0 ? (
                  <p className="px-2 py-2 text-sm text-muted-foreground">
                    No {label} sources in this Workspace.
                  </p>
                ) : (
                  <ul className="mt-1 flex flex-col gap-1">
                    {sources.map((source) => (
                      <SourceRow
                        key={source.sourceKey}
                        source={source}
                        pending={pendingOf(source.sourceKey)}
                        onEdit={
                          canEdit && ScopeEditor
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
              </div>
            )
          })}
          <Link
            href={`/${orgSlug}/connectors`}
            className={cn(
              "mt-6 inline-block rounded-md text-sm text-teal-400 underline-offset-4 transition-colors hover:text-teal-300 hover:underline",
              focusVisibleClassName,
            )}
          >
            Connect another source
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
