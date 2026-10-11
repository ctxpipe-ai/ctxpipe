import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { ChooseWorkspacesStep } from "@/features/workspace-sources/ChooseWorkspacesStep"
import {
  type ChooseWorkspacesValue,
  chooseWorkspacesRequests,
  emptyChooseWorkspaces,
} from "@/features/workspace-sources/choose-workspaces"
import { useAddToWorkspaces } from "@/features/workspace-sources/useAddToWorkspaces"

type AddToWorkspacesStepProps = {
  orgSlug: string
  atlassianConnectionId: string
  /** After the add, or when the user skips the step. */
  onDone: () => void
}

/** The last setup step: choose the Workspaces that sync Confluence, and their spaces. */
export function AddToWorkspacesStep({
  orgSlug,
  atlassianConnectionId,
  onDone,
}: AddToWorkspacesStepProps) {
  const [value, setValue] = useState<ChooseWorkspacesValue>(
    emptyChooseWorkspaces,
  )
  const base = {
    provider: "confluence" as const,
    connectionId: atlassianConnectionId,
  }
  const requests = chooseWorkspacesRequests(value, base)
  const addMutation = useAddToWorkspaces({
    orgSlug,
    connectionId: atlassianConnectionId,
    onAdded: onDone,
  })
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Add Confluence to Workspaces
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Select the Workspaces that sync from Confluence, and the spaces and
          pages for each.
        </p>
      </div>
      <ChooseWorkspacesStep
        orgSlug={orgSlug}
        {...base}
        value={value}
        onChange={setValue}
      />
      <div className="flex justify-end gap-2">
        <Button
          variant="quiet"
          isDisabled={addMutation.isPending}
          onPress={onDone}
        >
          Skip for now
        </Button>
        <Button
          variant="primary"
          isDisabled={!requests}
          isPending={addMutation.isPending}
          onPress={() => requests && addMutation.mutate(requests)}
        >
          Add to Workspaces
        </Button>
      </div>
    </div>
  )
}
