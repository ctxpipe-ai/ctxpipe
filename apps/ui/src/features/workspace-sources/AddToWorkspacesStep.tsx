import type { SourceProvider } from "backend/domain/workspace-sources/sources-file"

import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { Link } from "@/components/ui/Link"

import { ChooseWorkspacesStep } from "./ChooseWorkspacesStep"
import {
  type OpenedPullRequest,
  useAddToWorkspaces,
} from "./useAddToWorkspaces"

type AddToWorkspacesStepProps = {
  orgSlug: string
  provider: SourceProvider
  connectionId: string
  /** The provider name, for example "Notion". */
  label: string
  /** What the user selects for each Workspace, for example "the services for each". */
  description: string
  /** What the earlier setup selected, for example "the services". */
  items: string
  /**
   * The config pull request of an earlier setup (before Workspace sources).
   * ctxpipe does not use it now; the step tells the user to close it.
   */
  replacedConfigPullUrl?: string | null
  /** After the save, with the pull requests that it opened. */
  onDone: (pullRequests: OpenedPullRequest[]) => void
}

/**
 * The last step of a connector setup: choose the Workspaces that sync the
 * connection, and the scope of each (ADR-050). On Manage it starts from the
 * current sources of the connection.
 */
export function AddToWorkspacesStep({
  orgSlug,
  provider,
  connectionId,
  label,
  description,
  items,
  replacedConfigPullUrl,
  onDone,
}: AddToWorkspacesStepProps) {
  const adding = useAddToWorkspaces({
    orgSlug,
    provider,
    connectionId,
    manage: true,
    onAdded: onDone,
  })
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Add {label} to Workspaces
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Select the Workspaces that sync from {label}, and {description}.
        </p>
      </div>
      {replacedConfigPullUrl ? (
        <InlineAlert variant="warning">
          This setup was replaced. ctxpipe no longer uses the{" "}
          <Link href={replacedConfigPullUrl} target="_blank" rel="noreferrer">
            configuration pull request
          </Link>{" "}
          of the earlier setup. Close it, and add {items} to a Workspace here
          instead.
        </InlineAlert>
      ) : null}
      {adding.loadFailed ? (
        <InlineAlert variant="error">
          Could not load the Workspaces that use {label}. Close this dialog and
          try again.
        </InlineAlert>
      ) : adding.ready ? (
        <ChooseWorkspacesStep
          orgSlug={orgSlug}
          provider={provider}
          connectionId={connectionId}
          value={adding.value}
          onChange={adding.setValue}
        />
      ) : (
        <InlineLoader label={`Loading the Workspaces that use ${label}`} />
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="primary"
          isDisabled={!adding.canAdd}
          isPending={adding.isPending}
          onPress={adding.add}
        >
          {adding.isManaging ? "Save changes" : "Add to Workspaces"}
        </Button>
      </div>
    </div>
  )
}
