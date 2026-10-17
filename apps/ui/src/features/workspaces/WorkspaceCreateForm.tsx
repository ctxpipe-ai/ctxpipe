import HyperDX from "@hyperdx/browser"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ComponentProps, type ReactNode, useState } from "react"
import { Heading } from "react-aria-components"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { ConnectorSetupStepper } from "@/features/connectors/components/ConnectorSetupStepper"
import { WorkspaceSources } from "@/features/workspace-sources/WorkspaceSources"
import { workspaceUpgradesOptions } from "@/features/workspace-upgrades/queries"
import { pollWhileOk } from "@/lib/api-result"
import { WRITE_CHECK_POLL_CAP_MS, writeCheckInFlight } from "./projection"
import {
  createWorkspace,
  workspaceDetailOptions,
  workspaceKeys,
} from "./queries"
import {
  type WorkspaceRepositoryChoice,
  WorkspaceRepositoryPicker,
} from "./WorkspaceRepositoryPicker"

/**
 * The fixed part of Add Workspace: the heading, the two steps, and the card of
 * the current step. The heading and the top of the card never move, so the
 * page does not shift while it loads or when step 2 replaces step 1.
 */
export function WorkspaceCreateFrame(props: {
  step: 0 | 1
  children: ReactNode
}) {
  const steps = [
    { id: "repository", label: "Choose the Workspace repository" },
    { id: "sources", label: "Add code repositories and tools" },
  ]
  return (
    <div className="w-full">
      {/* In the Add Workspace modal, the title slot names the dialog. */}
      <Heading
        slot="title"
        level={1}
        className="my-0 text-lg font-medium tracking-tight"
      >
        Add Workspace
      </Heading>
      <ConnectorSetupStepper
        className="mt-4"
        steps={steps}
        currentIndex={props.step}
      />
      <section aria-label={steps[props.step].label} className="mt-6 min-h-96">
        {props.children}
      </section>
    </div>
  )
}

/**
 * Add Workspace in two steps. Step 1 chooses the Workspace repository and
 * creates the Workspace. Step 2 adds code repositories and tools to it.
 *
 * On a page, the URL holds the step: the page passes `workspaceSlug` once the
 * Workspace exists and changes the URL in `onCreated`. Without them (the
 * modal), the form keeps the step itself. Step 1 never shows again for a
 * Workspace that exists.
 */
export function WorkspaceCreateForm(props: {
  orgSlug: string
  workspaceSlug?: string
  onCreated?: (workspaceSlug: string) => void
}) {
  const { orgSlug, onCreated } = props
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [createdSlug, setCreatedSlug] = useState<string | null>(null)
  const workspaceSlug = props.workspaceSlug ?? createdSlug

  const createMutation = useMutation({
    mutationFn: (choice: WorkspaceRepositoryChoice) =>
      createWorkspace(orgSlug, choice),
    onSuccess: (workspace) => {
      HyperDX.addAction("workspace_created")
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.list(orgSlug),
      })
      setCreatedSlug(workspace.slug)
      onCreated?.(workspace.slug)
    },
    onError: (err: Error) => setError(err.message),
  })

  return (
    <WorkspaceCreateFrame step={workspaceSlug ? 1 : 0}>
      {workspaceSlug ? (
        <AddSourcesStep orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            ctxpipe saves this Workspace’s knowledge in the repository you
            choose.
          </p>
          <div className="mt-4">
            <WorkspaceRepositoryPicker
              orgSlug={orgSlug}
              submitLabel="Create Workspace"
              pending={createMutation.isPending}
              error={error}
              onSubmit={(choice) => {
                setError(null)
                createMutation.mutate(choice)
              }}
            />
          </div>
        </>
      )}
    </WorkspaceCreateFrame>
  )
}

/**
 * The Sources section of Workspace settings, for the new Workspace. A new
 * Workspace starts with an unknown write status, and sources can only be
 * added after the write-access check, so the step waits for that check.
 * The wait stops at the same cap as the Workspace page, which owns
 * "Check again".
 */
function AddSourcesStep(props: { orgSlug: string; workspaceSlug: string }) {
  const { orgSlug, workspaceSlug } = props
  const navigate = useNavigate()
  const [startedAt] = useState(Date.now)
  const detailQuery = useQuery({
    ...workspaceDetailOptions(orgSlug, workspaceSlug),
    refetchInterval: (query) =>
      query.state.data &&
      writeCheckInFlight(query.state.data) &&
      query.state.dataUpdatedAt - startedAt < WRITE_CHECK_POLL_CAP_MS
        ? pollWhileOk(2000)(query)
        : false,
  })
  const workspace = detailQuery.data

  return (
    <>
      <p className="text-sm text-muted-foreground">
        ctxpipe reads these sources to answer questions. You can change them
        later under Sources in Workspace settings.
      </p>
      <div className="mt-4">
        {detailQuery.isError ? (
          <InlineAlert
            variant="error"
            title="Could not load the Workspace"
            actions={
              <Button
                variant="secondary"
                onPress={() => void detailQuery.refetch()}
              >
                Retry
              </Button>
            }
          >
            Try again, or open the Workspace and add sources in Settings.
          </InlineAlert>
        ) : !workspace ||
          (writeCheckInFlight(workspace) &&
            detailQuery.dataUpdatedAt - startedAt < WRITE_CHECK_POLL_CAP_MS) ? (
          <InlineLoader label="Checking write access" />
        ) : writeCheckInFlight(workspace) ? (
          <InlineAlert variant="warning" title="Still checking write access">
            The check takes longer than usual. Open the Workspace to check
            again, then add sources in Settings.
          </InlineAlert>
        ) : workspace.conversationWritable === false ? (
          <InlineAlert
            variant="warning"
            title={
              workspace.writeStatus === "unknown"
                ? "Could not check write access"
                : "Read-only"
            }
          >
            {workspace.readOnlyReason}
          </InlineAlert>
        ) : (
          <SourcesWhenRepositoryReady
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            linkedRepositories={workspace.linkedRepositories}
            workspaceRepositoryUrl={workspace.workspaceRepositoryUrl}
          />
        )}
      </div>
      <div className="mt-6 flex justify-end">
        <Button
          variant="primary"
          onPress={() => {
            void navigate({
              to: "/$orgSlug/ws/$workspaceSlug",
              params: { orgSlug, workspaceSlug },
            })
          }}
        >
          Open Workspace
        </Button>
      </div>
    </>
  )
}

/**
 * The backend refuses a source change until the Workspace repository has one
 * file for each source. A new empty repository gets its format file a few
 * seconds after the create, so this waits for it. A repository that already
 * had files has no format file until its upgrade pull request merges. The wait
 * stops at the same cap as the write-access check.
 */
function SourcesWhenRepositoryReady(
  props: ComponentProps<typeof WorkspaceSources>,
) {
  const { orgSlug, workspaceSlug } = props
  const navigate = useNavigate()
  const [startedAt] = useState(Date.now)
  // Mirrors SOURCE_FILES_FORMAT in apps/backend/src/domain/workspaces/workspace-format.ts.
  const sourceFilesFormat = 2
  const upgradesQuery = useQuery({
    ...workspaceUpgradesOptions(orgSlug, workspaceSlug),
    refetchInterval: (query) =>
      query.state.status !== "error" &&
      query.state.data?.formatVersion === null &&
      query.state.dataUpdatedAt - startedAt < WRITE_CHECK_POLL_CAP_MS
        ? 2000
        : false,
  })
  const formatVersion = upgradesQuery.data?.formatVersion

  if (upgradesQuery.isError)
    return (
      <InlineAlert
        variant="error"
        title="Could not read the Workspace repository"
        actions={
          <Button
            variant="secondary"
            onPress={() => void upgradesQuery.refetch()}
          >
            Retry
          </Button>
        }
      >
        Try again, or open the Workspace and add sources in Settings.
      </InlineAlert>
    )
  if (formatVersion === undefined || formatVersion === null)
    return upgradesQuery.dataUpdatedAt - startedAt < WRITE_CHECK_POLL_CAP_MS ? (
      <InlineLoader label="Setting up the Workspace repository" />
    ) : (
      <InlineAlert
        variant="warning"
        title="Still setting up the Workspace repository"
      >
        The setup takes longer than usual. Open the Workspace and add sources in
        Settings later.
      </InlineAlert>
    )
  if (formatVersion < sourceFilesFormat)
    return (
      <InlineAlert
        variant="warning"
        title="Upgrade this Workspace before you add sources"
        actions={
          <Button
            variant="secondary"
            onPress={() => {
              void navigate({
                to: "/$orgSlug/ws/$workspaceSlug",
                params: { orgSlug, workspaceSlug },
                search: { pane: "settings" },
              })
            }}
          >
            Review upgrades
          </Button>
        }
      >
        The repository already had files, so ctx| must upgrade it once. The
        upgrade opens a pull request. Merge it, then add sources.
      </InlineAlert>
    )
  return <WorkspaceSources {...props} />
}
