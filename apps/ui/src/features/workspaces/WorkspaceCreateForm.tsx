import HyperDX from "@hyperdx/browser"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ComponentProps, type ReactNode, useState } from "react"
import { Heading } from "react-aria-components"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { SkeletonChain } from "@/components/ui/Skeleton"
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
  WorkspaceRepositoryPickerSkeleton,
} from "./WorkspaceRepositoryPicker"

/**
 * The fixed part of Add Workspace: the heading, the two steps, and the card of
 * the current step. The heading and the top of the card never move, so the
 * page does not shift while it loads or when step 2 replaces step 1.
 * The card is one skeleton chain, so a skeleton in the card can hand over to
 * the next one (see `SkeletonChain`).
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
      <section aria-label={steps[props.step].label} className="mt-6">
        <SkeletonChain id="add-workspace">{props.children}</SkeletonChain>
      </section>
    </div>
  )
}

function ChooseRepositoryIntro() {
  return (
    <p className="text-sm text-muted-foreground">
      ctxpipe saves this Workspace’s knowledge in the repository you choose.
    </p>
  )
}

function AddSourcesIntro() {
  return (
    <p className="text-sm text-muted-foreground">
      ctxpipe reads these sources to answer questions. You can change them later
      under Sources in Workspace settings.
    </p>
  )
}

/**
 * The page before the session answers: the frame and the card of the step
 * that the URL names, with the same text and the same wait as the real step.
 */
export function WorkspaceCreateFallback(props: { step: 0 | 1 }) {
  return (
    <WorkspaceCreateFrame step={props.step}>
      {props.step === 0 ? (
        <>
          <ChooseRepositoryIntro />
          <div className="mt-4">
            <WorkspaceRepositoryPickerSkeleton />
          </div>
        </>
      ) : (
        <>
          <AddSourcesIntro />
          <div className="mt-4">
            <InlineLoader label="Checking write access" />
          </div>
        </>
      )}
    </WorkspaceCreateFrame>
  )
}

/**
 * Add Workspace in two steps. Step 1 chooses the Workspace repository and
 * creates the Workspace. Step 2 adds code repositories and tools to it.
 *
 * On a page, the URL holds the step: the page passes `onCreated` and, once the
 * Workspace exists, `workspaceSlug`. The page changes the URL in `onCreated`,
 * and in `onStartAgain` for a URL whose Workspace does not exist. Without
 * `onCreated` (the modal), the form keeps the step itself. Step 1 never shows
 * again for a Workspace that exists.
 */
export function WorkspaceCreateForm(props: {
  orgSlug: string
  workspaceSlug?: string
  onCreated?: (workspaceSlug: string) => void
  onStartAgain?: () => void
}) {
  const { orgSlug, onCreated, onStartAgain } = props
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [createdSlug, setCreatedSlug] = useState<string | null>(null)
  const workspaceSlug = onCreated ? props.workspaceSlug : createdSlug

  const createMutation = useMutation({
    mutationFn: (choice: WorkspaceRepositoryChoice) =>
      createWorkspace(orgSlug, choice),
    onSuccess: () => {
      HyperDX.addAction("workspace_created")
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.list(orgSlug),
      })
    },
    onError: (err: Error) => setError(err.message),
  })

  return (
    <WorkspaceCreateFrame step={workspaceSlug ? 1 : 0}>
      {workspaceSlug ? (
        <AddSourcesOfWorkspace
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          onStartAgain={onStartAgain}
        />
      ) : (
        <>
          <ChooseRepositoryIntro />
          <div className="mt-4">
            <WorkspaceRepositoryPicker
              orgSlug={orgSlug}
              submitLabel="Create Workspace"
              pending={createMutation.isPending}
              error={error}
              onSubmit={(choice) => {
                setError(null)
                // These callbacks do not run after the form has gone. A user
                // who left while the call ran keeps the page they opened.
                createMutation.mutate(choice, {
                  onSuccess: (workspace) => {
                    if (onCreated) onCreated(workspace.slug)
                    else setCreatedSlug(workspace.slug)
                  },
                })
              }}
            />
          </div>
        </>
      )}
    </WorkspaceCreateFrame>
  )
}

/** Step 2, or a way back to step 1 when the Workspace does not exist. */
function AddSourcesOfWorkspace(props: {
  orgSlug: string
  workspaceSlug: string
  onStartAgain?: () => void
}) {
  const { orgSlug, workspaceSlug, onStartAgain } = props
  // The same query as in `AddSourcesStep`, so the two share one request. The
  // API answers a missing Workspace with 404, and the query holds `null`.
  const detailQuery = useQuery(workspaceDetailOptions(orgSlug, workspaceSlug))

  if (detailQuery.isSuccess && detailQuery.data === null) {
    return (
      <InlineAlert
        variant="warning"
        title="Workspace not found"
        actions={
          onStartAgain ? (
            <Button variant="secondary" onPress={onStartAgain}>
              Start again
            </Button>
          ) : undefined
        }
      >
        This Workspace does not exist, or you cannot open it. Start again to
        create a new Workspace.
      </InlineAlert>
    )
  }
  return <AddSourcesStep orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
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
      <AddSourcesIntro />
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
