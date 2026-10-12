import HyperDX from "@hyperdx/browser"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { Heading } from "react-aria-components"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { ConnectorSetupStepper } from "@/features/connectors/components/ConnectorSetupStepper"
import { WorkspaceSources } from "@/features/workspace-sources/WorkspaceSources"
import { pollWhileOk } from "@/lib/api-result"
import { writeCheckInFlight } from "./projection"
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
 * Add Workspace in two steps. Step 1 chooses the Workspace repository and
 * creates the Workspace. Step 2 adds code repositories and tools to it.
 */
export function WorkspaceCreateForm(props: {
  orgSlug: string
  /** Replaces the default navigation to the new Workspace. */
  onDone?: (slug: string) => void
}) {
  const { orgSlug, onDone } = props
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [createdSlug, setCreatedSlug] = useState<string | null>(null)

  const createMutation = useMutation({
    mutationFn: (choice: WorkspaceRepositoryChoice) =>
      createWorkspace(orgSlug, choice),
    onSuccess: (workspace) => {
      HyperDX.addAction("workspace_created")
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.list(orgSlug),
      })
      setCreatedSlug(workspace.slug)
    },
    onError: (err: Error) => setError(err.message),
  })

  const done = (slug: string) => {
    if (onDone) {
      onDone(slug)
      return
    }
    void navigate({
      to: "/$orgSlug/ws/$workspaceSlug",
      params: { orgSlug, workspaceSlug: slug },
    })
  }

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
        steps={[
          { id: "repository", label: "Choose the Workspace repository" },
          { id: "sources", label: "Add code repositories and tools" },
        ]}
        currentIndex={createdSlug ? 1 : 0}
      />
      {createdSlug ? (
        <AddSourcesStep
          orgSlug={orgSlug}
          workspaceSlug={createdSlug}
          onDone={() => done(createdSlug)}
        />
      ) : (
        <>
          <p className="mt-6 text-sm text-muted-foreground">
            ctxpipe saves this Workspace’s knowledge in this repository.
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
    </div>
  )
}

/**
 * The Connectors section of Workspace settings, for the new Workspace. A new
 * Workspace starts with an unknown write status, and sources can only be
 * added after the write-access check, so the step waits for that check.
 */
function AddSourcesStep(props: {
  orgSlug: string
  workspaceSlug: string
  onDone: () => void
}) {
  const { orgSlug, workspaceSlug, onDone } = props
  const detailQuery = useQuery({
    ...workspaceDetailOptions(orgSlug, workspaceSlug),
    refetchInterval: (query) =>
      query.state.data && writeCheckInFlight(query.state.data)
        ? pollWhileOk(2000)(query)
        : false,
  })
  const workspace = detailQuery.data

  return (
    <>
      <p className="mt-6 text-sm text-muted-foreground">
        ctxpipe reads them to answer questions. You can change them later under
        Connectors in Workspace settings.
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
        ) : !workspace || writeCheckInFlight(workspace) ? (
          <InlineLoader label="Checking write access" />
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
          <WorkspaceSources
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            linkedRepositories={workspace.linkedRepositories}
            workspaceRepositoryUrl={workspace.workspaceRepositoryUrl}
          />
        )}
      </div>
      <div className="mt-6 flex justify-end">
        <Button variant="primary" onPress={onDone}>
          Open Workspace
        </Button>
      </div>
    </>
  )
}
