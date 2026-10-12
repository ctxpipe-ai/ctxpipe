import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { ChooseWorkspacesStep } from "@/features/workspace-sources/ChooseWorkspacesStep"
import { useAddToWorkspaces } from "@/features/workspace-sources/useAddToWorkspaces"

type AddNotionToWorkspacesStepProps = {
  orgSlug: string
  connectionId: string
  /**
   * The config pull request of an earlier setup (before Workspace sources).
   * ctx| does not use it now; the step tells the user to close it.
   */
  replacedConfigPullUrl?: string | null
  /** After the add, or when the user skips the step. */
  onDone: () => void
}

/** The last setup step: choose the Workspaces that sync Notion, and their pages. */
export function AddNotionToWorkspacesStep({
  orgSlug,
  connectionId,
  replacedConfigPullUrl,
  onDone,
}: AddNotionToWorkspacesStepProps) {
  const adding = useAddToWorkspaces({
    orgSlug,
    provider: "notion",
    connectionId,
    onAdded: onDone,
  })
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Add Notion to Workspaces
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Select the Workspaces that sync from Notion, and the pages and
          databases for each.
        </p>
      </div>
      {replacedConfigPullUrl ? (
        <InlineAlert variant="warning">
          This setup was replaced. ctx| no longer uses the{" "}
          <a
            href={replacedConfigPullUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            configuration pull request
          </a>{" "}
          of the earlier setup. Close it, and add the pages to a Workspace here
          instead.
        </InlineAlert>
      ) : null}
      <ChooseWorkspacesStep
        orgSlug={orgSlug}
        provider="notion"
        connectionId={connectionId}
        value={adding.value}
        onChange={adding.setValue}
      />
      <div className="flex justify-end gap-2">
        <Button variant="quiet" isDisabled={adding.isPending} onPress={onDone}>
          Skip for now
        </Button>
        <Button
          variant="primary"
          isDisabled={!adding.canAdd}
          isPending={adding.isPending}
          onPress={adding.add}
        >
          Add to Workspaces
        </Button>
      </div>
    </div>
  )
}
