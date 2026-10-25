import HyperDX from "@hyperdx/browser"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, useState } from "react"
import { Heading } from "react-aria-components"

import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { SkeletonChain } from "@/components/ui/Skeleton"
import { ConnectorSetupStepper } from "@/features/connectors/components/ConnectorSetupStepper"
import {
  useGithubEmptyAction,
  WorkspaceSources,
} from "@/features/workspace-sources/WorkspaceSources"
import { workspaceNeedsFormatUpgrade } from "@/features/workspace-upgrades/format-gate"
import {
  upgradesRefetchInterval,
  workspaceUpgradesOptions,
} from "@/features/workspace-upgrades/queries"
import { formatHealthLine } from "@/features/workspace-upgrades/upgrade-copy"
import { pollWhileOk } from "@/lib/api-result"
import { workspaceCreatedFlag } from "@/lib/session-flags"

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
function WorkspaceCreateFrame(props: { step: 0 | 1; children: ReactNode }) {
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
 *
 * With `onDone`, step 2 ends with "Done" and stays on the page (the Home
 * guide shows the build); without it, step 2 opens the Workspace.
 */
export function WorkspaceCreateForm(props: {
  orgSlug: string
  workspaceSlug?: string
  onCreated?: (workspaceSlug: string) => void
  onStartAgain?: () => void
  onDone?: () => void
}) {
  const { orgSlug, onCreated, onStartAgain, onDone } = props
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [createdSlug, setCreatedSlug] = useState<string | null>(null)
  const workspaceSlug = onCreated ? props.workspaceSlug : createdSlug

  const createMutation = useMutation({
    mutationFn: (choice: WorkspaceRepositoryChoice) =>
      createWorkspace(orgSlug, choice),
    onSuccess: () => {
      HyperDX.addAction("workspace_created")
      workspaceCreatedFlag.set()
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
          onDone={onDone}
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
  onDone?: () => void
}) {
  const { orgSlug, workspaceSlug, onStartAgain, onDone } = props
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
  return (
    <AddSourcesStep
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      onDone={onDone}
    />
  )
}

/**
 * The Sources section of Workspace settings, for the new Workspace. Sources
 * can only be added when two checks pass, one after the other. First the
 * write-access check, which a new Workspace starts with an unknown status.
 * Then the repository format: a new empty repository gets its format file a
 * few seconds later, and a repository that already had files stays below
 * format 2 until its upgrade pull request merges. Both waits share one start
 * time and stop at the same cap as the Workspace page, which owns "Check
 * again".
 */
function AddSourcesStep(props: {
  orgSlug: string
  workspaceSlug: string
  onDone?: () => void
}) {
  const { orgSlug, workspaceSlug, onDone } = props
  const navigate = useNavigate()
  const [startedAt, setStartedAt] = useState(Date.now)
  const withinCap = (updatedAt: number) =>
    updatedAt - startedAt < WRITE_CHECK_POLL_CAP_MS
  const detailQuery = useQuery({
    ...workspaceDetailOptions(orgSlug, workspaceSlug),
    refetchInterval: (query) =>
      query.state.data &&
      writeCheckInFlight(query.state.data) &&
      withinCap(query.state.dataUpdatedAt)
        ? pollWhileOk(2000)(query)
        : false,
  })
  const workspace = detailQuery.data
  const writeCheckPending = !workspace || writeCheckInFlight(workspace)
  const upgradesQuery = useQuery({
    ...workspaceUpgradesOptions(orgSlug, workspaceSlug),
    enabled: !writeCheckPending && workspace.conversationWritable !== false,
    // The repository has no format yet: poll fast, up to the cap. Once the
    // format is known, the upgrades poll follows an upgrade item.
    refetchInterval: (query) =>
      query.state.data?.formatVersion === null
        ? withinCap(query.state.dataUpdatedAt)
          ? pollWhileOk(2000)(query)
          : false
        : upgradesRefetchInterval(query),
  })
  const upgrades = upgradesQuery.data
  // With nothing chosen yet, "Add repositories" in Sources is the one primary
  // action, and "Done" waits. The hook only reads what Sources loads.
  const addRepositoriesIsPrimary = useGithubEmptyAction({
    orgSlug,
    workspaceSlug,
    linkedRepositories: workspace?.linkedRepositories,
    enabled: false,
  })

  const content = () => {
    const failed = detailQuery.isError
      ? detailQuery
      : upgradesQuery.isError
        ? upgradesQuery
        : null
    if (failed)
      return (
        <InlineAlert
          variant="error"
          title="Could not load the Workspace"
          actions={
            <Button variant="secondary" onPress={() => void failed.refetch()}>
              Retry
            </Button>
          }
        >
          Try again, or open the Workspace and add sources in Settings.
        </InlineAlert>
      )
    if (writeCheckPending)
      return withinCap(detailQuery.dataUpdatedAt) ? (
        <InlineLoader label="Checking write access" />
      ) : (
        <InlineAlert
          variant="warning"
          title="Still checking write access"
          actions={
            <Button
              variant="secondary"
              onPress={() => {
                setStartedAt(Date.now())
                void detailQuery.refetch()
              }}
            >
              Retry
            </Button>
          }
        >
          The check takes longer than usual. Try again, or open the Workspace
          and add sources in Settings later.
        </InlineAlert>
      )
    if (workspace.conversationWritable === false)
      return (
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
      )
    if (!upgrades || upgrades.formatVersion === null)
      return withinCap(upgradesQuery.dataUpdatedAt) ? (
        <InlineLoader label="Setting up the Workspace repository" />
      ) : (
        <InlineAlert
          variant="warning"
          title="Still setting up the Workspace repository"
          actions={
            <Button
              variant="secondary"
              onPress={() => {
                setStartedAt(Date.now())
                void upgradesQuery.refetch()
              }}
            >
              Retry
            </Button>
          }
        >
          The setup takes longer than usual. Try again, or open the Workspace
          and add sources in Settings later.
        </InlineAlert>
      )
    // A format file that is not valid reads as a negative number. A format
    // above the one that ctxpipe reads makes the Workspace read-only. Neither
    // case is fixed with an upgrade.
    const { formatVersion, codeFormat } = upgrades
    if (formatVersion < 0 || formatVersion > codeFormat)
      return (
        <InlineAlert variant="warning" title="Read-only">
          {formatHealthLine(formatVersion, codeFormat)}
        </InlineAlert>
      )
    if (workspaceNeedsFormatUpgrade({ items: [], formatVersion, codeFormat }))
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
          Sources need the newest repository format. An owner or admin starts
          the upgrade. It opens a pull request. Merge it, then add sources.
        </InlineAlert>
      )
    return (
      <WorkspaceSources
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        linkedRepositories={workspace.linkedRepositories}
      />
    )
  }

  return (
    <>
      <AddSourcesIntro />
      <div className="mt-4">{content()}</div>
      <div className="mt-6 flex justify-end">
        <Button
          variant={addRepositoriesIsPrimary ? "secondary" : "primary"}
          onPress={() => {
            if (onDone) {
              onDone()
              return
            }
            void navigate({
              to: "/$orgSlug/ws/$workspaceSlug",
              params: { orgSlug, workspaceSlug },
            })
          }}
        >
          {onDone ? "Done" : "Open Workspace"}
        </Button>
      </div>
    </>
  )
}
